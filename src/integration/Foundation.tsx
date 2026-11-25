import { useEffect, useRef, useState } from 'react'
import App from '../app/App'
import type { FoundationAction, FoundationPreview } from '../app/App'
import type { DisplayResponse } from '../features/exam/QuestionRenderer'
import { createAttempt, isAttemptSnapshot, transitionAttempt } from '../domain'
import type { AttemptEvent, CandidateAnswer, ExamAttempt, ExamCycle } from '../domain'
import { createExamRepository, StorageError } from '../storage'
import type { WriterLease } from '../storage'
import { ATTEMPT_ID, CYCLE_ID, PREVIEW_VERSION, previewBatch, previewCycle, previewOptionOrder, previewQuestion, sectionTitles } from '../data/synthetic-preview'
import { LEASE_MS, tabWriter } from './tab-writer'

const shape = (attempt: ExamAttempt): boolean => {
  if (!isAttemptSnapshot(attempt) || attempt.cycleId !== CYCLE_ID ||
      attempt.batch.id !== previewBatch.id || attempt.contentVersion !== PREVIEW_VERSION ||
      attempt.batch.seed !== previewBatch.seed || attempt.batch.mode !== previewBatch.mode ||
      attempt.batch.sections.some((section, index) => {
        const expected = previewBatch.sections[index]
        return !expected || section.kind !== expected.kind || section.caseStudyId !== expected.caseStudyId ||
          section.questionIds.length !== expected.questionIds.length ||
          section.questionIds.some((id, position) => id !== expected.questionIds[position])
      }) ||
      Object.keys(attempt.optionOrder).length !== Object.keys(previewOptionOrder).length ||
      Object.entries(previewOptionOrder).some(([id, order]) => JSON.stringify(attempt.optionOrder[id]) !== JSON.stringify(order)) ||
      attempt.result !== null ||
      (attempt.status === 'SUBMITTED') !== (attempt.submittedAt !== null) || attempt.status === 'SCORED') return false

  return Object.entries(attempt.answers).every(([id, response]) => {
    const owner = previewBatch.sections.find((item) => item.questionIds.includes(id))
    if (!owner || !response || typeof response !== 'object') return false
    const question = previewQuestion(id, attempt.optionOrder[id])
    const { interaction } = question
    if (response.kind !== interaction.kind) return false
    if (response.kind === 'SINGLE_CHOICE' && 'options' in interaction) {
      return interaction.options.some((item) => item.id === response.optionId)
    }
    if ('selections' in response && 'targets' in interaction && response.selections &&
        typeof response.selections === 'object' && !Array.isArray(response.selections)) {
      const entries = Object.entries(response.selections)
      return entries.length > 0 && entries.every(([targetId, value]) => interaction.targets.some(
        (target) => target.id === targetId && target.options.some((option) => option.id === value),
      ))
    }
    return false
  }) && Object.entries(attempt.reviewMarks).every(([id, mark]) =>
    previewCycle.reservedQuestionIds.includes(id) && typeof mark === 'boolean',
  )
}

const initialAttempt = () => createAttempt({ id: ATTEMPT_ID, cycleId: CYCLE_ID, batch: previewBatch, optionOrder: previewOptionOrder })
type ViewState = {
  attempt: ExamAttempt
  status: string
  notice?: string
  readOnly: boolean
  takeover?: boolean
  hasUnsavedChange?: boolean
  canRetrySave?: boolean
  review?: boolean
}

function asDisplay(answer: CandidateAnswer): DisplayResponse {
  if (answer.kind === 'SINGLE_CHOICE') return { selected: [answer.optionId] }
  if (answer.kind === 'MULTIPLE_CHOICE') return { selected: answer.optionIds }
  if (answer.kind === 'ORDERING') return { order: answer.optionIds }
  if ('selections' in answer) return { targets: Object.fromEntries(
    Object.entries(answer.selections).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  ) }
  return {}
}

function candidateResponse(id: string, optionOrder: readonly string[] | undefined, response: DisplayResponse, previous?: CandidateAnswer): CandidateAnswer | null {
  const { interaction } = previewQuestion(id, optionOrder)
  if (interaction.kind === 'SINGLE_CHOICE' && 'options' in interaction) {
    const selected = response.selected?.[0]
    return interaction.options.some((item) => item.id === selected) && selected
      ? { kind: 'SINGLE_CHOICE', optionId: selected } : null
  }
  if ((interaction.kind === 'MATCHING' || interaction.kind === 'DROPDOWN_HOTSPOT') && 'targets' in interaction) {
    const delta = response.targetChange
    const selections = delta ? {
      ...(previous && 'selections' in previous ? previous.selections : {}),
      [delta.id]: delta.value ?? undefined,
    } : response.targets ?? {}
    const entries = interaction.targets.flatMap((target) => {
      const value = selections[target.id]
      return value && target.options.some((option) => option.id === value) ? [[target.id, value] as const] : []
    })
    return entries.length ? { kind: interaction.kind, selections: Object.fromEntries(entries) } : null
  }
  return null
}

export function Foundation() {
  const [state, setState] = useState<ViewState>(() => ({ attempt: initialAttempt(), status: 'Opening browser storage…', readOnly: true }))
  const dispatchRef = useRef<(action: FoundationAction) => void>(() => undefined)

  useEffect(() => {
    const repo = createExamRepository<ExamAttempt, ExamCycle>({
      leaseDurationMs: LEASE_MS,
      validateAttempt: shape,
      validateCycle: (cycle) => cycle.id === CYCLE_ID &&
        cycle.contentVersion === PREVIEW_VERSION && Array.isArray(cycle.reservedQuestionIds) &&
        cycle.reservedQuestionIds.length === 59 && Array.isArray(cycle.consumedQuestionIds) &&
        new Set(cycle.reservedQuestionIds).size === 59 && cycle.reservedQuestionIds.every((id) => previewCycle.reservedQuestionIds.includes(id)),
    })
    let stopped = false
    let current = initialAttempt()
    let lease: WriterLease | null = null
    let identity: Awaited<ReturnType<typeof tabWriter>> | undefined
    let review = false
    let pending: AttemptEvent | null = null
    let pendingBaseRevision: number | null = null
    let tail: Promise<unknown> = Promise.resolve()
    const queue = (job: () => Promise<void>) => {
      tail = tail.catch(() => undefined).then(async () => { if (!stopped) await job() })
    }
    const show = (status: string, notice?: string, take = false) => {
      if (!stopped) setState({ attempt: current, status, notice, readOnly: !lease || Boolean(pending), review, takeover: take,
        hasUnsavedChange: Boolean(pending), canRetrySave: Boolean(pending && lease),
      })
    }
    const attachWriter = async (granted: WriterLease) => {
      // The record may have changed between the initial read and the lease grant.
      // Load again under the newly fenced writer before showing an editable view.
      const latest = await repo.load(ATTEMPT_ID, PREVIEW_VERSION)
      if (!latest || latest.lease?.writerId !== granted.writerId || latest.lease.token !== granted.token) {
        throw new StorageError('LEASE_LOST')
      }
      current = latest.attempt
      lease = latest.lease
    }
    const recover = async (error: unknown) => {
      if (error instanceof StorageError && ['WRITER_ACTIVE', 'TAKEOVER_REQUIRED', 'LEASE_LOST', 'STALE_REVISION'].includes(error.code)) {
        lease = null
        try {
          const latest = await repo.load(ATTEMPT_ID, PREVIEW_VERSION)
          if (latest) current = latest.attempt
          show('Read-only in this tab', 'Another editing session holds the saved attempt. You can take over once its lease expires.', Boolean(latest))
          return
        } catch (loadError) {
          error = loadError
        }
      }
      lease = null
      if (error instanceof StorageError && error.code === 'CONTENT_VERSION_MISMATCH') {
        show('Saved content version cannot be resumed', 'This saved attempt is pinned to a different preview version. Nothing was replaced or removed.')
        return
      }
      const message = error instanceof StorageError ? error.message : 'Browser storage could not be opened. The attempt was not changed.'
      show('Local storage unavailable', message)
    }

    const commit = async (event: AttemptEvent, announce = true) => {
      if (!lease) return false
      const result = transitionAttempt(current, event)
      if (!result.ok) {
        show(pending ? 'Not saved' : 'Action not applied', pending
          ? 'The unsaved change no longer applies to this stage. Discard it to use the saved attempt.'
          : 'This action is not available at the current stage.')
        return false
      }
      if (result.attempt === current) return true
      try {
        if (announce) show('Saving…')
        current = await repo.save({ attempt: result.attempt, expectedRevision: current.revision, lease })
        if (pending === event) { pending = null; pendingBaseRevision = null }
        if (announce) show('Saved on this device')
        return true
      } catch (error) {
        if (event.type === 'SAVE_ANSWER' || event.type === 'TOGGLE_REVIEW') {
          pending = event
          pendingBaseRevision = current.revision
        }
        if (error instanceof StorageError && ['UNAVAILABLE', 'QUOTA_EXCEEDED'].includes(error.code)) {
          show('Not saved', error.message + (pending ? ' Retry or discard this change to continue.' : ' Retry the action to continue.'))
        } else {
          await recover(error)
        }
        return false
      }
    }

    queue(async () => {
      try {
        identity = await tabWriter()
        if (stopped) {
          identity.release()
          return
        }
        const existing = await repo.load(ATTEMPT_ID, PREVIEW_VERSION)
        if (existing) {
          current = existing.attempt
          await attachWriter(await repo.acquireWriter(ATTEMPT_ID, identity.id))
        } else {
          try {
            await attachWriter(await repo.initialize({ attempt: current, cycle: previewCycle, contentVersion: PREVIEW_VERSION, writerId: identity.id }))
          } catch (error) {
            if (!(error instanceof StorageError) || error.code !== 'ALREADY_EXISTS') throw error
            const latest = await repo.load(ATTEMPT_ID, PREVIEW_VERSION)
            if (!latest) throw error
            current = latest.attempt
            await attachWriter(await repo.acquireWriter(ATTEMPT_ID, identity.id))
          }
        }
        show('Saved on this device')
      } catch (error) {
        await recover(error)
      }
    })

    dispatchRef.current = (action) => queue(async () => {
      if (action.type === 'TAKE_OVER' && identity) {
        try {
          const existing = await repo.load(ATTEMPT_ID, PREVIEW_VERSION)
          if (!existing) return
          current = existing.attempt
          await attachWriter(await repo.acquireWriter(ATTEMPT_ID, identity.id, { takeover: true, expectedToken: existing.lease?.token }))
          review = false
          if (pending) show('Not saved', 'Retry or discard the unsaved change to continue.')
          else show('Saved on this device')
        } catch (error) {
          await recover(error)
        }
        return
      }
      if (action.type === 'RETRY_SAVE') {
        if (pending && lease) {
          if (pendingBaseRevision !== current.revision) show('Not saved', 'The saved attempt changed in another tab. Discard the unsaved change before continuing.')
          else await commit(pending)
        }
        return
      }
      if (action.type === 'DISCARD_UNSAVED') {
        if (pending) {
          pending = null
          pendingBaseRevision = null
          show(lease ? 'Saved on this device' : 'Read-only in this tab', 'Unsaved change discarded.', !lease)
        }
        return
      }
      if (!lease || pending) return
      const at = Date.now()
      if (action.type === 'START') {
        if (current.status === 'CREATED' && !(await commit({ type: 'PREPARE', at }))) return
        await commit({ type: 'START_SECTION', at })
      } else if (action.type === 'OPEN_REVIEW' || action.type === 'CLOSE_REVIEW') {
        if (!current.activeSection) return
        review = action.type === 'OPEN_REVIEW'
        show('Saved on this device')
      } else if (action.type === 'NAVIGATE') {
        if (await commit({ type: 'NAVIGATE', position: action.position, at })) {
          review = false
          show('Saved on this device')
        }
      } else if (action.type === 'TOGGLE_MARK') {
        await commit({ type: 'TOGGLE_REVIEW', questionId: action.questionId, at })
      } else if (action.type === 'ANSWER') {
        const section = current.batch.sections.find((item) => item.kind === current.activeSection)
        if (!section?.questionIds.includes(action.questionId)) return
        await commit({ type: 'SAVE_ANSWER', questionId: action.questionId, answer: candidateResponse(action.questionId, current.optionOrder[action.questionId], action.response, current.answers[action.questionId]), at })
      } else if (action.type === 'SUBMIT_SECTION') {
        if (!current.activeSection || current.activeSection !== action.sectionId) return
        if (!await commit({ type: 'SUBMIT_SECTION', section: current.activeSection, at })) return
        review = false
        if (current.locks.length === 4) await commit({ type: 'OPEN_FINAL_REVIEW', at })
        else await commit({ type: 'START_SECTION', at })
      } else if (action.type === 'FINAL_SUBMIT') {
        if (current.status === 'INTERACTIVE_BLOCK_SUBMITTED' && !await commit({ type: 'OPEN_FINAL_REVIEW', at })) return
        await commit({ type: 'FINAL_SUBMIT', at })
      }
    })

    const heartbeat = window.setInterval(() => queue(async () => {
      if (!lease || !identity) return
      try {
        lease = await repo.acquireWriter(ATTEMPT_ID, identity.id)
      } catch (error) {
        await recover(error)
      }
    }), LEASE_MS / 3)
    // Let the database fence expire on close. An unload release can otherwise
    // race a reload that correctly resumed with the same tab identity and token.
    const release = () => { identity?.release() }
    const pageHide = (event: PageTransitionEvent) => { if (!event.persisted) release() }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (pending) event.preventDefault()
    }
    window.addEventListener('pagehide', pageHide)
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      stopped = true
      window.clearInterval(heartbeat)
      window.removeEventListener('pagehide', pageHide)
      window.removeEventListener('beforeunload', beforeUnload)
      release()
      void tail.finally(() => repo.close())
    }
  }, [])

  const { attempt } = state
  const section = attempt.batch.sections.find((item) => item.kind === attempt.activeSection) ?? attempt.batch.sections[attempt.locks.length]
  const kind = section?.kind ?? 'FINAL_INTERACTIVE_BLOCK'
  const final = attempt.status === 'FINAL_SUBMISSION_PENDING' || attempt.status === 'INTERACTIVE_BLOCK_SUBMITTED'
  const complete = attempt.status === 'SUBMITTED' || attempt.status === 'SCORED'
  const view = complete ? 'complete' : final ? 'final' : !attempt.activeSection ? 'intro' : state.review ? 'review' : 'question'

  useEffect(() => {
    const path = view === 'intro' ? '#/start' : '#/' + view
    const guard = () => {
      if (window.location.hash !== path) window.history.replaceState(null, '', path)
    }
    guard()
    window.addEventListener('hashchange', guard)
    window.addEventListener('popstate', guard)
    return () => {
      window.removeEventListener('hashchange', guard)
      window.removeEventListener('popstate', guard)
    }
  }, [view])

  const preview: FoundationPreview = {
    sections: attempt.batch.sections.map((item) => ({
      id: item.kind, label: sectionTitles[item.kind], count: item.questionIds.length,
      state: attempt.locks.includes(item.kind) ? 'locked' : item.kind === kind ? 'current' : 'upcoming',
    })),
    activeSectionId: kind,
    questions: section?.questionIds.map((id) => previewQuestion(id, attempt.optionOrder[id])) ?? [],
    position: attempt.position,
    answers: Object.fromEntries(Object.entries(attempt.answers).flatMap(([id, answer]) => answer ? [[id, asDisplay(answer)]] : [])),
    marks: Object.entries(attempt.reviewMarks).filter(([, marked]) => marked).map(([id]) => id),
    view,
    context: kind.startsWith('CASE_STUDY') ? {
      title: 'Sample context',
      paragraphs: ['This demonstration shows where shared case material will appear. Only synthetic controls are included in the public engineering preview.'],
    } : undefined,
    status: { label: state.status, tone: state.notice ? 'warning' : 'neutral' },
    readOnly: state.readOnly,
    notice: state.notice,
    canTakeOver: state.takeover,
    hasUnsavedChange: state.hasUnsavedChange,
    canRetrySave: state.canRetrySave,
  }
  return <App preview={preview} onAction={(action) => dispatchRef.current(action)} />
}
