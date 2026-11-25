import { Component, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import App from '../app/App'
import type { FoundationAction, FoundationPreview } from '../app/App'
import { crossedExamWarning, examExpirationAt, examSectionKey, getRemainingTimeMs } from '../domain'
import { readDisplayResponse } from '../features/exam/question-response'
import { createExamRepository, StorageError } from '../storage'
import type { SavedExam, WriterLease } from '../storage'
import { ATTEMPT_ID, previewBatch, previewContext, previewQuestion, sectionTitles } from '../data/synthetic-preview'
import {
  atIntermediateBoundary, candidateChange, candidateExamSummary, candidateQuestion, candidateSection, candidateValidators,
  initialCandidate, isRecoveryAction, restoreCandidateCursor,
} from './candidate-attempt'
import type { CandidateChange, CandidateCycle, CandidateEdit, CandidateSnapshot, FoundationSource } from './candidate-attempt'
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
  finalizing?: boolean
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
  const [timer, setTimer] = useState<FoundationPreview['timer']>()
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
    const warningMinutes = source.timerWarningMinutes ?? []
    type Edit = { change: CandidateChange; base: number; baseCycleRevision: number; optimistic: boolean }
    const edits: Edit[] = []
    let stopped = false
    let saved: SavedExam<CandidateSnapshot, CandidateCycle> | null = null
    let lease: WriterLease | null = null
    let identity: Awaited<ReturnType<typeof tabWriter>> | undefined
    let blocked: DisplayError | undefined
    let inFlight = false
    let failed = false
    let conflict = false
    let dueAt: number | null = null
    let lastRemaining: number | undefined
    let announcement: string | undefined
    let lastExpiryAttempt = -Infinity
    let draining = false
    let tail: Promise<unknown> = Promise.resolve()
    const queue = (job: () => Promise<void>) => {
      tail = tail.catch(() => undefined).then(async () => { if (!stopped) await job() })
    }
    const projected = () => edits.at(-1)?.change ?? saved
    const terminalQueued = () => edits.at(-1)?.change.attempt.status === 'SUBMITTED'
    const finalizing = () => dueAt !== null || terminalQueued()
    const expiresAt = () => projected()?.attempt.expiresAt
    const baseMatches = () => !edits.length || (edits[0].base === saved?.attempt.revision
      && edits[0].baseCycleRevision === saved.cycleRevision)
    const show = (status: string, notice?: string, take = false) => {
      if (stopped) return
      const freezing = finalizing() && saved?.attempt.status !== 'SUBMITTED'
      // Do not reveal navigation, section locks, or a submission before its
      // durable transaction has committed. Draft response values are controlled.
      const optimistic = !freezing && lease && baseMatches()
        ? edits.findLast((edit) => edit.optimistic)?.change.attempt : undefined
      setState({
        attempt: optimistic ?? saved?.attempt ?? null,
        status, notice, error: blocked, finalizing: freezing,
        readOnly: !lease || failed || Boolean(blocked) || freezing,
        takeover: !freezing && take,
        hasUnsavedChange: failed && !freezing && edits.length > 0,
        canRetrySave: edits.length > 0 && Boolean(lease) && baseMatches() && !freezing,
      })
    }
    const updateTimer = (at: number) => {
      const remainingMs = getRemainingTimeMs(expiresAt(), at)
      if (stopped || remainingMs === null || saved?.attempt.status === 'SUBMITTED') {
        if (!stopped) setTimer(undefined)
        return
      }
      if (dueAt !== null) announcement = 'Time has expired. Your examination is being submitted.'
      else if (lastRemaining !== undefined) {
        const minutes = crossedExamWarning(lastRemaining, remainingMs, warningMinutes)
        if (minutes !== null) announcement = minutes + (minutes === 1 ? ' minute remaining.' : ' minutes remaining.')
      }
      lastRemaining = remainingMs
      setTimer((previous) => previous && Math.ceil(previous.remainingMs / 1000) === Math.ceil(remainingMs / 1000)
        && previous.expired === (dueAt !== null) && previous.announcement === announcement ? previous
        : { remainingMs, expired: dueAt !== null, announcement })
    }
    const noticeExpiry = () => show(failed ? 'Submission not saved' : 'Submitting examination…', failed
      ? 'This examination is locked while this tab retries submission. Keep this page open.'
      : dueAt !== null ? 'Time has expired. Your examination is being submitted.' : undefined)
    const reconcile = (record: SavedExam<CandidateSnapshot, CandidateCycle> | null) => {
      saved = record ? { ...record, attempt: restoreCandidateCursor(record.attempt) } : null
      if (edits.length && !baseMatches()) {
        // A different fenced writer won. Never write these stale answers over
        // a newer section or revision, and never pretend the stale edit saved.
        conflict = true
        if (saved?.attempt.status === 'SUBMITTED' || finalizing()) {
          edits.length = 0
          failed = false
        }
      }
    }
    const observeExpiry = (at: number) => {
      const current = projected()?.attempt
      if (!saved || saved.attempt.status === 'SUBMITTED' || !current) return false
      if (dueAt === null && current.status !== 'SUBMITTED'
        && typeof current.expiresAt === 'number' && at >= current.expiresAt) {
        dueAt = at
        noticeExpiry()
      }
      return dueAt !== null
    }
    const showPassive = () => {
      if (saved?.attempt.status === 'SUBMITTED') {
        show('Saved on this device', conflict
          ? 'Another tab finalized this attempt. An unsaved change in this tab could not be added.' : undefined)
        return
      }
      if (observeExpiry(Date.now())) { noticeExpiry(); return }
      const eligible = Boolean(saved && (!saved.lease || saved.lease.expiresAt <= Date.now()))
      show('Read-only in this tab', conflict
        ? 'The saved attempt changed in another tab. An unsaved action from this tab could not be added.'
        : eligible
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
      const latest = await repo.load(attemptId, version)
      if (!latest || latest.lease?.writerId !== granted.writerId || latest.lease.token !== granted.token) {
        throw new StorageError('LEASE_LOST')
      }
      reconcile(latest)
      lease = latest.lease
    }

    async function resumeEditor(record: SavedExam<CandidateSnapshot, CandidateCycle>) {
      if (!identity) throw new StorageError('LEASE_LOST')
      // Resuming the Web-Lock-protected identity may renew its own expired
      // fence without requiring a click. It can never displace another live
      // tab, and expired sessions of a different tab remain opt-in.
      const sameExpired = record.lease?.writerId === identity.id && record.lease.expiresAt <= Date.now()
      await attachWriter(await repo.acquireWriter(attemptId, identity.id,
        sameExpired ? { takeover: true, expectedToken: record.lease!.token } : undefined))
    }

    const accept = (action: CandidateEdit | { type: 'TIME_EXPIRED' | 'RESUME_BOUNDARY' }, at: number) => {
      const base = projected()
      if (!saved || !base || !baseMatches()) return false
      let change: CandidateChange | null
      try {
        change = candidateChange(base.attempt, base.cycle, source, action, at)
      } catch {
        queue(releaseOnDisplayFailure)
        return false
      }
      if (!change) return false
      const baseCycleRevision = saved.cycleRevision + edits.filter((edit, index) =>
        edit.change.cycle !== (index ? edits[index - 1].change.cycle : saved!.cycle)).length
      edits.push({ change, base: base.attempt.revision, baseCycleRevision,
        optimistic: action.type === 'ANSWER' || action.type === 'TOGGLE_MARK' })
      return true
    }

    const acquireForExpiry = async () => {
      if (!identity || !saved || saved.attempt.status === 'SUBMITTED') return false
      if (lease && lease.expiresAt > Date.now()) return true
      const latest = await repo.load(attemptId, version)
      if (!latest) throw new StorageError('NOT_FOUND')
      reconcile(latest)
      if (latest.attempt.status === 'SUBMITTED') { showPassive(); return false }
      if (latest.lease && latest.lease.expiresAt > Date.now() && latest.lease.writerId !== identity.id) return false
      const expiredLease = latest.lease && latest.lease.expiresAt <= Date.now()
      await attachWriter(await repo.acquireWriter(attemptId, identity.id,
        expiredLease ? { takeover: true, expectedToken: latest.lease!.token } : undefined))
      return true
    }

    const drain = async () => {
      if (!saved || (blocked && blocked !== renderError)) return
      observeExpiry(Date.now())
      if ((blocked || displayFailed.current) && !finalizing()) return
      if (saved.attempt.status === 'SUBMITTED') { showPassive(); return }
      if (finalizing()) {
        try {
          if (!(await acquireForExpiry())) return
          if (dueAt !== null && projected()?.attempt.status !== 'SUBMITTED') {
            if (!baseMatches()) { edits.length = 0; conflict = true }
            // Append timeout to all valid responses synchronously accepted
            // before zero, including changes behind the failing write.
            if (!accept({ type: 'TIME_EXPIRED' }, dueAt)) return
          }
        } catch (error) {
          await recover(error)
          return
        }
      }
      while (lease && saved && edits.length && (!failed || finalizing()) && baseMatches()) {
        const last = edits.at(-1)!
        const terminal = last.change.attempt.status === 'SUBMITTED'
        // Collapse undurable pre-cutoff work and the terminal action into
        // a single lease-fenced revision. A transactional failure leaves the
        // preceding durable state intact and the captured buffer retryable.
        const count = terminal ? edits.length : 1
        const change = terminal ? last.change : edits[0].change
        const durable: SavedExam<CandidateSnapshot, CandidateCycle> = saved
        const cycleChanged = change.cycle !== durable.cycle
        try {
          inFlight = true
          if (terminal || finalizing()) noticeExpiry()
          else show('Saving…')
          const attempt = await repo.save({
            attempt: { ...change.attempt, revision: durable.attempt.revision + 1 },
            expectedRevision: durable.attempt.revision, lease,
            ...(cycleChanged ? { cycleUpdate: { cycle: change.cycle, expectedRevision: durable.cycleRevision } } : {}),
          })
          const cycleRevision = durable.cycleRevision + (cycleChanged ? 1 : 0)
          saved = { ...durable, attempt: restoreCandidateCursor(attempt), cycle: change.cycle, cycleRevision, lease }
          edits.splice(0, count)
          failed = false
          if (attempt.status === 'SUBMITTED') {
            dueAt = null
            if (blocked === renderError) blocked = undefined
            show('Saved on this device', conflict
              ? 'An unsaved change from the previous editing session could not be added.' : undefined)
            updateTimer(Date.now())
            return
          }
          const observedAt = Date.now()
          if (observeExpiry(observedAt) && projected()?.attempt.status !== 'SUBMITTED') {
            if (!accept({ type: 'TIME_EXPIRED' }, dueAt!)) return
          }
          // Publish the persisted start/deadline immediately after the write.
          updateTimer(observedAt)
          if (!edits.length) show('Saved on this device')
        } catch (error) {
          failed = true
          observeExpiry(Date.now())
          if (error instanceof StorageError && ['UNAVAILABLE', 'QUOTA_EXCEEDED'].includes(error.code)) {
            if (finalizing()) noticeExpiry()
            else show('Save failed', error.message + ' Retry or discard this unsaved change before continuing.')
          } else {
            await recover(error)
          }
          return
        } finally {
          inFlight = false
        }
      }
    }
    const requestDrain = () => {
      if (draining || stopped) return
      draining = true
      queue(async () => {
        try { await drain() } finally { draining = false }
      })
    }
    const tick = () => {
      const now = Date.now()
      const due = observeExpiry(now)
      updateTimer(now)
      if (due || finalizing()) {
        // Retry transient terminal persistence failures automatically. A
        // follower may take over only to finalize, once the prior lease expires.
        const elapsed = performance.now()
        if (elapsed - lastExpiryAttempt >= 750) {
          lastExpiryAttempt = elapsed
          requestDrain()
        }
      }
    }

    const ready = async () => {
      if (observeExpiry(Date.now()) || finalizing()) { await drain(); return }
      if (edits.length) {
        if (!failed && baseMatches()) await drain()
        else {
          failed = true
          show('Save failed', baseMatches() ? 'Retry or discard the unsaved change to continue.'
            : 'The saved examination changed in another tab. Discard the unsaved change to continue.')
        }
      } else if (saved && atIntermediateBoundary(saved.attempt) && accept({ type: 'RESUME_BOUNDARY' }, Date.now())) {
        await drain()
      } else {
        show('Saved on this device')
      }
      updateTimer(Date.now())
    }

    queue(async () => {
      try {
        const record = await repo.load(attemptId, version)
        if (stopped) return
        reconcile(record)
        identity = await tabWriter()
        if (stopped) { identity.release(); return }
        if (record) {
          if (observeExpiry(Date.now())) { await drain(); return }
          await resumeEditor(record)
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

    dispatchRef.current = (action) => {
      if (displayFailed.current || blocked) return
      const at = Date.now()
      if (observeExpiry(at) || finalizing()) { requestDrain(); return }
      if (!isRecoveryAction(action)) {
        if (action.type === 'START' && source.examDurationMinutes !== undefined
          && examExpirationAt(at, source.examDurationMinutes) === null) {
          show('Examination did not start', 'The configured exam duration is invalid. No examination progress was changed.')
          return
        }
        // Timestamp and accept against the latest locally captured draft now,
        // not when an older IndexedDB request or a throttled interval resumes.
        if (!lease || failed || edits.some((edit) => !edit.optimistic) || !accept(action, at)) return
        if (finalizing()) noticeExpiry()
        else show('Saving…')
        requestDrain()
        return
      }
      queue(async () => {
        if (observeExpiry(Date.now()) || finalizing()) { await drain(); return }
        if (action.type === 'RETRY_SAVE') {
          if (edits.length && lease && baseMatches()) { failed = false; await drain() }
          return
        }
        if (action.type === 'DISCARD_UNSAVED') {
          if (!failed || !edits.length) return
          edits.length = 0
          failed = false
          conflict = false
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
    }

    const refresh = async (renew: boolean) => {
      if (!identity || blocked || displayFailed.current) return
      try {
        if (observeExpiry(Date.now()) || finalizing()) { await drain(); return }
        if (lease) {
          if (renew) {
            if (lease.expiresAt <= Date.now()) {
              const record = await repo.load(attemptId, version)
              if (!record) throw new StorageError('NOT_FOUND')
              await resumeEditor(record)
              await ready()
            } else lease = await repo.acquireWriter(attemptId, identity.id)
          }
          return
        }
        const latest = await repo.load(attemptId, version)
        if (!latest) throw new StorageError('NOT_FOUND')
        reconcile(latest)
        if (!observeExpiry(Date.now()) && latest.attempt.status !== 'SUBMITTED'
          && latest.lease?.writerId === identity.id) {
          await resumeEditor(latest)
          await ready()
        } else {
          showPassive()
          if (finalizing()) await drain()
          updateTimer(Date.now())
        }
      } catch (error) {
        await recover(error)
      }
    }
    const heartbeat = window.setInterval(() => queue(() => refresh(true)), LEASE_MS / 3)
    const passivePoll = window.setInterval(() => {
      if (!lease) queue(() => refresh(false))
    }, 1_500)
    const countdown = window.setInterval(tick, 250)
    const focused = () => { tick(); queue(() => refresh(true)) }
    const pageHide = (event: PageTransitionEvent) => { if (!event.persisted) identity?.release() }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (edits.length || inFlight || finalizing()) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('focus', focused)
    window.addEventListener('pageshow', focused)
    document.addEventListener('visibilitychange', focused)
    window.addEventListener('pagehide', pageHide)
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      stopped = true
      dispatchRef.current = () => undefined
      abortDisplay.current = () => undefined
      window.clearInterval(heartbeat)
      window.clearInterval(passivePoll)
      window.clearInterval(countdown)
      window.removeEventListener('focus', focused)
      window.removeEventListener('pageshow', focused)
      document.removeEventListener('visibilitychange', focused)
      window.removeEventListener('pagehide', pageHide)
      window.removeEventListener('beforeunload', beforeUnload)
      identity?.release()
      void tail.finally(() => repo.close()).catch(() => undefined)
    }
  }, [source])

  const { attempt } = state
  const hasStarted = Boolean(attempt && attempt.status !== 'CREATED' && attempt.status !== 'READY')
  const active = attempt ? candidateSection(attempt) : undefined
  const section = active ?? source.batch.sections[attempt?.locks.length ?? 0]
  const sectionId = section ? examSectionKey(section) : ''
  const complete = attempt?.status === 'SUBMITTED'
  const final = attempt?.status === 'FINAL_SUBMISSION_PENDING'
    || Boolean(attempt && atIntermediateBoundary(attempt) && attempt.locks.length === attempt.batch.sections.length)
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
    sections: source.batch.sections.map((item) => {
      const id = examSectionKey(item)
      const label = item.kind === 'REMAINDER_CASE_STUDY' ? 'Case Study'
        : item.kind === 'REMAINDER_UNSECTIONED' ? 'Other Questions' : sectionTitles[item.kind]
      return { id, kind: item.kind, label, count: item.questionIds.length,
        state: attempt?.locks.includes(id) ? 'locked' : id === sectionId ? 'current' : 'upcoming',
      }
    }),
    activeSectionId: sectionId,
    batchMode: source.batch.batchMode,
    questions: [],
    position: attempt?.position ?? 0,
    view,
    examTitle: source.examTitle,
    synthetic: source.synthetic,
    contentNotice: source.contentNotice,
    timer,
    finalizing: state.finalizing,
    finalizationReason: attempt?.finalizationReason ?? undefined,
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
    if (attempt && hasStarted && !complete) preview = { ...basic, examSummary: candidateExamSummary(source, attempt) }
    if (active && attempt && (view === 'question' || view === 'review')) {
      const questions = active.questionIds.map((id) => candidateQuestion(source, id))
      const questionId = view === 'question' ? active.questionIds[attempt.position] : undefined
      // A normal allocation can place a dual-approved case child in another
      // section. Keep its approved source context without changing its role,
      // order, interaction, or the section submission rules.
      const sourceCases = source.batch.sourceCaseStudyIds
      const contextId = active.caseStudyId ?? (questionId && Object.hasOwn(sourceCases, questionId) ? sourceCases[questionId] : undefined)
      preview = {
        ...preview, questions,
        context: contextId ? source.context?.(contextId) : undefined,
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
