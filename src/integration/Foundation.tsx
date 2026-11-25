import { Component, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import App from '../app/App'
import type { FoundationAction, FoundationPreview } from '../app/App'
import { readDisplayResponse } from '../features/exam/question-response'
import { createExamRepository, StorageError } from '../storage'
import type { SavedExam, WriterLease } from '../storage'
import { ATTEMPT_ID, previewBatch, previewContext, previewQuestion, sectionTitles } from '../data/synthetic-preview'
import {
  atIntermediateBoundary, candidateChange, candidateQuestion, candidateSection, candidateValidators,
  initialCandidate, isRecoveryAction, restoreCandidateCursor,
} from './candidate-attempt'
import type { CandidateCycle, CandidateSnapshot, FoundationSource } from './candidate-attempt'
import { LEASE_MS, tabWriter } from './tab-writer'

export type { FoundationSource } from './candidate-attempt'

const syntheticSource: FoundationSource = {
  attemptId: ATTEMPT_ID, batch: previewBatch, question: previewQuestion, synthetic: true,
  context: previewContext,
}

type DisplayError = NonNullable<FoundationPreview['error']>
type ViewState = {
  attempt: CandidateSnapshot | null
  status: string
  notice?: string
  error?: DisplayError
  readOnly: boolean
  takeover?: boolean
  hasUnsavedChange?: boolean
  canRetrySave?: boolean
}

const opening: ViewState = { attempt: null, status: 'Opening browser storage…', readOnly: true }
const renderError: DisplayError = {
  title: 'Examination content unavailable',
  description: 'This content could not be displayed. Reload the same examination to try again. Your saved progress has not been reset.',
}

class CandidateDisplayBoundary extends Component<{ children: ReactNode; fallback: ReactNode; onError?: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { this.props.onError?.() }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

function CandidateSession({ source }: { source: FoundationSource }) {
  const [state, setState] = useState<ViewState>(opening)
  const dispatchRef = useRef<(action: FoundationAction) => void>(() => undefined)
  const displayFailed = useRef(false)
  const abortDisplay = useRef<() => void>(() => undefined)

  useEffect(() => {
    let repo: ReturnType<typeof createExamRepository<CandidateSnapshot, CandidateCycle>>
    try {
      repo = createExamRepository<CandidateSnapshot, CandidateCycle>({
        databaseName: source.idbName,
        leaseDurationMs: LEASE_MS,
        ...candidateValidators(source),
      })
    } catch {
      // The initialization promise/effect never passes invalid content to the editor.
      const report = window.requestAnimationFrame(() => setState({ ...opening, status: 'Content unavailable', error: renderError }))
      return () => window.cancelAnimationFrame(report)
    }

    const { attemptId } = source
    const version = source.batch.contentVersion
    let stopped = false
    let saved: SavedExam<CandidateSnapshot, CandidateCycle> | null = null
    let lease: WriterLease | null = null
    let identity: Awaited<ReturnType<typeof tabWriter>> | undefined
    let blocked: DisplayError | undefined
    let inFlight = false
    let pending: { change: NonNullable<ReturnType<typeof candidateChange>>; revision: number; cycleRevision: number; optimistic: boolean } | null = null
    let tail: Promise<unknown> = Promise.resolve()
    const queue = (job: () => Promise<void>) => {
      tail = tail.catch(() => undefined).then(async () => { if (!stopped) await job() })
    }

    const show = (status: string, notice?: string, take = false, optimistic?: CandidateSnapshot) => {
      if (stopped) return
      const canRetry = pending !== null && lease !== null
        && pending.revision === saved?.attempt.revision && pending.cycleRevision === saved.cycleRevision
      setState({
        attempt: optimistic ?? (canRetry && pending?.optimistic ? pending.change.attempt : saved?.attempt ?? null),
        status, notice, error: blocked, readOnly: !lease || Boolean(pending) || Boolean(blocked),
        takeover: take, hasUnsavedChange: Boolean(pending), canRetrySave: canRetry,
      })
    }

    const reconcile = (record: SavedExam<CandidateSnapshot, CandidateCycle> | null) => {
      saved = record ? { ...record, attempt: restoreCandidateCursor(record.attempt) } : null
    }

    const showPassive = () => {
      const eligible = Boolean(saved && (!saved.lease || saved.lease.expiresAt <= Date.now()))
      show('Read-only in this tab', eligible
        ? 'The editing session has ended. Choose Take over editing to continue here.'
        : 'This examination is open for editing in another tab. You can follow saved progress here without making changes.', eligible)
    }

    const recover = async (error: unknown) => {
      if (stopped) return
      lease = null
      if (error instanceof StorageError && ['WRITER_ACTIVE', 'TAKEOVER_REQUIRED', 'LEASE_LOST', 'STALE_REVISION', 'CYCLE_CONFLICT'].includes(error.code)) {
        try {
          reconcile(await repo.load(attemptId, version))
          if (saved) { showPassive(); return }
          error = new StorageError('NOT_FOUND')
        } catch (loadError) {
          error = loadError
        }
      }

      if (error instanceof StorageError && error.code === 'CONTENT_VERSION_MISMATCH') {
        blocked = {
          title: 'Saved content version cannot be resumed',
          description: 'This attempt is pinned to a different version. Open it with the original approved content to resume. Nothing was replaced or removed.',
        }
      } else if (error instanceof StorageError && error.code === 'CORRUPT') {
        blocked = { title: 'Saved examination could not be opened', description: error.message }
      } else {
        blocked = {
          title: 'Local storage unavailable',
          description: 'Reload the examination after checking that you can use browser storage. No new attempt was created and no saved data was replaced.',
        }
      }
      show(blocked.title)
    }

    const releaseOnDisplayFailure = async () => {
      if (blocked === renderError) return
      blocked = renderError
      const previousLease = lease
      lease = null
      show('Content unavailable')
      // No edits are accepted while content is unavailable. Drop a healthy
      // lease here, but never overwrite a lease acquired by a later tab.
      try {
        if (previousLease) await repo.releaseWriter(attemptId, previousLease)
      } catch { /* The fence may already have expired; leave the durable attempt intact. */ }
      identity?.release()
    }
    abortDisplay.current = () => {
      displayFailed.current = true
      queue(releaseOnDisplayFailure)
    }

    const attachWriter = async (granted: WriterLease) => {
      // Loading after acquire guards the read→grant race. Pair validation here
      // also checks the persisted attempt against the actual Phase 4 batch status.
      const latest = await repo.load(attemptId, version)
      if (!latest || latest.lease?.writerId !== granted.writerId || latest.lease.token !== granted.token) {
        throw new StorageError('LEASE_LOST')
      }
      reconcile(latest)
      lease = latest.lease
    }

    const save = async (edit: NonNullable<typeof pending>) => {
      if (!lease || !saved) return
      if (edit.revision !== saved.attempt.revision || edit.cycleRevision !== saved.cycleRevision) {
        show('Save failed', 'The saved examination changed in another tab. Discard this unsaved change to continue.')
        return
      }
      const { change } = edit
      const cycleChanged = change.cycle !== saved.cycle
      const durable = saved
      // Make answer controls controlled by the tentative local value. Do not
      // advance an exam boundary or new question until its save is durable.
      if (pending === edit) pending = null
      inFlight = true
      show('Saving…', undefined, false, edit.optimistic ? change.attempt : undefined)
      try {
        const attempt = await repo.save({
          attempt: change.attempt, expectedRevision: edit.revision, lease,
          ...(cycleChanged ? { cycleUpdate: { cycle: change.cycle, expectedRevision: edit.cycleRevision } } : {}),
        })
        saved = {
          ...durable, attempt: restoreCandidateCursor(attempt), cycle: change.cycle,
          cycleRevision: durable.cycleRevision + (cycleChanged ? 1 : 0), lease,
        }
        show('Saved on this device')
      } catch (error) {
        pending = edit
        if (error instanceof StorageError && ['UNAVAILABLE', 'QUOTA_EXCEEDED'].includes(error.code)) {
          show('Save failed', error.message + ' Retry or discard this unsaved change before continuing.')
        } else {
          await recover(error)
        }
      } finally {
        inFlight = false
      }
    }

    const write = async (action: Exclude<FoundationAction, { type: 'TAKE_OVER' | 'RETRY_SAVE' | 'DISCARD_UNSAVED' }> | { type: 'RESUME_BOUNDARY' }) => {
      if (!saved || !lease || pending || blocked || displayFailed.current) return
      let change: ReturnType<typeof candidateChange>
      try {
        change = candidateChange(saved.attempt, saved.cycle, source, action, Date.now())
      } catch {
        // No response was committed against an unavailable question contract.
        await releaseOnDisplayFailure()
        return
      }
      if (!change) return
      await save({
        change, revision: saved.attempt.revision, cycleRevision: saved.cycleRevision,
        optimistic: action.type === 'ANSWER' || action.type === 'TOGGLE_MARK',
      })
    }

    const ready = async () => {
      if (pending) {
        const fresh = saved?.attempt.revision === pending.revision && saved.cycleRevision === pending.cycleRevision
        show('Save failed', fresh ? 'Retry or discard the unsaved change to continue.'
          : 'The saved examination changed in another tab. Discard the unsaved change to continue.')
      } else if (saved && atIntermediateBoundary(saved.attempt)) {
        await write({ type: 'RESUME_BOUNDARY' })
      } else {
        show('Saved on this device')
      }
    }

    queue(async () => {
      try {
        const record = await repo.load(attemptId, version)
        if (stopped) return
        reconcile(record)
        identity = await tabWriter()
        if (stopped) { identity.release(); return }
        if (record) {
          await attachWriter(await repo.acquireWriter(attemptId, identity.id))
        } else {
          try {
            const initial = initialCandidate(source, Date.now())
            await attachWriter(await repo.initialize({ ...initial, contentVersion: version, writerId: identity.id }))
          } catch (error) {
            if (!(error instanceof StorageError) || error.code !== 'ALREADY_EXISTS') throw error
            await attachWriter(await repo.acquireWriter(attemptId, identity.id))
          }
        }
        await ready()
      } catch (error) {
        await recover(error)
      }
    })

    dispatchRef.current = (action) => queue(async () => {
      if (displayFailed.current || blocked) return
      if (!isRecoveryAction(action)) { await write(action); return }
      if (action.type === 'RETRY_SAVE') {
        if (pending && lease) await save(pending)
        return
      }
      if (action.type === 'DISCARD_UNSAVED') {
        if (!pending) return
        pending = null
        if (lease) await ready()
        else showPassive()
        return
      }
      if (action.type === 'TAKE_OVER' && identity && !lease) {
        try {
          const record = await repo.load(attemptId, version)
          if (!record) throw new StorageError('NOT_FOUND')
          await attachWriter(await repo.acquireWriter(attemptId, identity.id, { takeover: true, expectedToken: record.lease?.token }))
          await ready()
        } catch (error) {
          await recover(error)
        }
      }
    })

    const refresh = async (renew: boolean) => {
      if (!identity || blocked || displayFailed.current) return
      try {
        if (lease) {
          if (renew) lease = await repo.acquireWriter(attemptId, identity.id)
          return
        }
        const latest = await repo.load(attemptId, version)
        if (!latest) throw new StorageError('NOT_FOUND')
        reconcile(latest)
        showPassive()
      } catch (error) {
        await recover(error)
      }
    }
    const heartbeat = window.setInterval(() => queue(() => refresh(true)), LEASE_MS / 3)
    const passivePoll = window.setInterval(() => {
      if (!lease) queue(() => refresh(false))
    }, 1_500)
    const focused = () => queue(() => refresh(true))
    const pageHide = (event: PageTransitionEvent) => { if (!event.persisted) identity?.release() }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (pending || inFlight) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('focus', focused)
    window.addEventListener('pageshow', focused)
    window.addEventListener('pagehide', pageHide)
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      stopped = true
      dispatchRef.current = () => undefined
      abortDisplay.current = () => undefined
      window.clearInterval(heartbeat)
      window.clearInterval(passivePoll)
      window.removeEventListener('focus', focused)
      window.removeEventListener('pageshow', focused)
      window.removeEventListener('pagehide', pageHide)
      window.removeEventListener('beforeunload', beforeUnload)
      // Keep the database fence for same-document reload safety; unlike the
      // authoritatively time-fenced IndexedDB lease, the Web Lock is document-only.
      identity?.release()
      void tail.finally(() => repo.close()).catch(() => undefined)
    }
  }, [source])

  const { attempt } = state
  const hasStarted = Boolean(attempt && attempt.status !== 'CREATED' && attempt.status !== 'READY')
  const active = attempt ? candidateSection(attempt) : undefined
  const section = active ?? source.batch.sections[attempt?.locks.length ?? 0]
  const complete = attempt?.status === 'SUBMITTED'
  const final = attempt?.status === 'FINAL_SUBMISSION_PENDING' || attempt?.status === 'INTERACTIVE_BLOCK_SUBMITTED'
  let view: NonNullable<FoundationPreview['view']> = state.error ? 'error' : complete ? 'complete'
    : final ? 'final' : !hasStarted ? 'intro' : !active ? 'intro'
    : attempt?.candidateView === 'review' ? 'review' : 'question'
  if (hasStarted && !active && view === 'intro') view = 'error'
  const defaultError = hasStarted && !active && view === 'error' && !state.error
    ? { title: 'Section change pending', description: 'This section is already locked. Resume editing to continue to the next section.' }
    : undefined

  const reconcileRoute = Boolean(state.attempt || state.error)
  useEffect(() => {
    if (!reconcileRoute) return
    // The URL only reflects persisted navigation. It never loads a section,
    // cursor, answer, review state, or action from user-controlled parameters.
    const path = view === 'intro' ? '#/start' : '#/' + view
    const guard = () => {
      if (window.location.hash !== path) window.history.replaceState(window.history.state, '', path)
    }
    guard()
    window.addEventListener('hashchange', guard)
    window.addEventListener('popstate', guard)
    return () => {
      window.removeEventListener('hashchange', guard)
      window.removeEventListener('popstate', guard)
    }
  }, [view, reconcileRoute])

  const basic: FoundationPreview = {
    sections: source.batch.sections.map((item) => ({
      id: item.kind, label: sectionTitles[item.kind], count: item.questionIds.length,
      state: attempt?.locks.includes(item.kind) ? 'locked' : item.kind === section?.kind ? 'current' : 'upcoming',
    })),
    activeSectionId: section?.kind ?? '',
    questions: [],
    position: attempt?.position ?? 0,
    view,
    examTitle: source.examTitle,
    synthetic: source.synthetic,
    contentNotice: source.contentNotice,
    status: { label: state.status, tone: state.error ? 'error' : state.notice ? 'warning' : 'neutral' },
    readOnly: state.readOnly || view === 'error',
    notice: state.notice,
    error: state.error ?? defaultError,
    canTakeOver: state.takeover,
    hasUnsavedChange: state.hasUnsavedChange,
    canRetrySave: state.canRetrySave,
  }
  const fallback = {
    ...basic, view: 'error' as const, readOnly: true, canTakeOver: false, hasUnsavedChange: false, error: renderError,
    status: { label: 'Content unavailable', tone: 'error' as const },
  }
  let preview = basic
  let contentFailed = false
  try {
    if (active && attempt && (view === 'question' || view === 'review')) {
      const questions = active.questionIds.map((id) => candidateQuestion(source, id))
      preview = {
        ...basic, questions,
        context: active.caseStudyId ? source.context?.(active.caseStudyId) : undefined,
        answers: Object.fromEntries(questions.flatMap(({ id, interaction }) => {
          const display = readDisplayResponse(interaction, attempt.answers[id])
          return display ? [[id, display]] : []
        })),
        marks: active.questionIds.filter((id) => attempt.reviewMarks[id] === true),
      }
    }
    displayFailed.current = false
  } catch {
    displayFailed.current = true
    contentFailed = true
    preview = fallback
  }
  useEffect(() => {
    if (contentFailed) abortDisplay.current()
  }, [contentFailed])

  return (
    <CandidateDisplayBoundary fallback={<App preview={fallback} />} onError={() => abortDisplay.current()}>
      <App preview={preview} onAction={(action) => dispatchRef.current(action)} />
    </CandidateDisplayBoundary>
  )
}

export function Foundation({ source = syntheticSource }: { readonly source?: FoundationSource } = {}) {
  return <CandidateSession key={JSON.stringify([source.idbName, source.attemptId, source.batch.contentVersion])} source={source} />
}
