import type { FoundationAction, FoundationPreview, FoundationQuestion } from '../app/App'
import { atSubmittedSectionBoundary, createAttempt, examSectionKey, isAttemptSnapshot, nextExistingSection, transitionAttempt } from '../domain'
import type { AttemptEvent, ExamAttempt } from '../domain'
import type { GeneratedBatch } from '../domain/batch-engine'
import { activeExamCycle, createCycleLifecycle, isCycleLifecycle, transitionCycleLifecycle } from '../domain/cycle-lifecycle'
import type { CycleLifecycle } from '../domain/cycle-lifecycle'
import { isCandidateAnswerFor, toCandidateAnswer } from '../features/exam/question-response'

export interface FoundationSource {
  readonly attemptId: string
  readonly batch: GeneratedBatch
  readonly question: (id: string, optionOrder: readonly string[] | undefined) => FoundationQuestion
  readonly context?: (caseStudyId: string) => FoundationPreview['context']
  readonly idbName?: string
  readonly examTitle?: string
  readonly synthetic?: boolean
  readonly contentNotice?: string
  /** Optional complete eligibility universe from a separately verified inventory. */
  readonly eligibleSourceIds?: readonly string[]
}

export interface CandidateSnapshot extends ExamAttempt {
  readonly candidateView: 'question' | 'review'
  readonly currentQuestionId: string | null
}

export interface CandidateCycle {
  readonly id: string
  readonly contentVersion: string
  readonly lifecycle: CycleLifecycle
}

const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && Array.from(a).every((value, i) => same(value, b[i]))
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const left = Object.entries(a)
  const right = b as Record<string, unknown>
  return left.length === Object.keys(right).length && left.every(([key, value]) => Object.hasOwn(right, key) && same(value, right[key]))
}

export function candidateSection(attempt: ExamAttempt) {
  return attempt.batch.sections.find((section) => examSectionKey(section) === attempt.activeSection)
}

// Phase 5 persisted normal generated plans before the additive metadata.
// Match their exact shape; never let metadata-bit stripping bypass adaptive
// plan validation or a source membership/order difference.
function samePinnedPlan(saved: GeneratedBatch, expected: GeneratedBatch): boolean {
  if (same(saved, expected)) return true
  if (saved.kind !== 'NORMAL_BATCH' || saved.batchMode !== undefined || expected.kind !== 'NORMAL_BATCH') return false
  const {
    batchId: _id, bankVersion: _version, batchMode: _mode, actualQuestionCount: _actual,
    targetQuestionCount: _target, caseStudyQuestionCount: _case, standardQuestionCount: _standard,
    interactiveQuestionCount: _interactive, unsectionedQuestionCount: _unsectioned, sourceCaseStudyIds: _provenance, ...legacy
  } = expected
  void [_id, _version, _mode, _actual, _target, _case, _standard, _interactive, _unsectioned, _provenance]
  return same(saved, legacy)
}

function withCursor(attempt: ExamAttempt, view: CandidateSnapshot['candidateView']): CandidateSnapshot {
  const active = candidateSection(attempt)
  return Object.freeze({
    ...attempt,
    candidateView: active ? view : 'question',
    currentQuestionId: active?.questionIds[attempt.position] ?? null,
  })
}

/** The guarded numeric position is authoritative. The optional human-readable
 * cursor is derived from it, never trusted to resolve into a submitted section. */
export function restoreCandidateCursor(attempt: CandidateSnapshot): CandidateSnapshot {
  return withCursor(attempt, attempt.candidateView === 'review' ? 'review' : 'question')
}

export function initialCandidate(source: FoundationSource, at: number): { attempt: CandidateSnapshot; cycle: CandidateCycle } {
  const plan = source.batch
  const lifecycle = createCycleLifecycle({
    id: plan.cycleId, cycleId: plan.cycleId, bankVersion: plan.contentVersion,
    eligibilityPolicy: plan.eligibilityPolicy, createdAt: at,
  })
  const generated = transitionCycleLifecycle(lifecycle, { type: 'GENERATE', batch: plan, at })
  if (!generated.ok) throw new TypeError('The examination batch could not be validated.')
  return {
    attempt: withCursor(createAttempt({
      id: source.attemptId, cycleId: plan.cycleId, batch: plan, optionOrder: plan.optionOrder, at,
    }), 'question'),
    cycle: { id: plan.cycleId, contentVersion: plan.contentVersion, lifecycle: generated.state },
  }
}

export function candidateQuestion(source: FoundationSource, id: string): FoundationQuestion {
  if (!source.batch.sourceIds.includes(id)) throw new TypeError('Question is outside the pinned batch.')
  const order = source.batch.optionOrder[id]
  const question = source.question(id, order)
  if (!question || question.id !== id || typeof question.prompt !== 'string'
    || !question.prompt.trim() || question.interaction?.kind !== source.batch.interactionKinds[id]) {
    throw new TypeError('Question display is unavailable for the pinned batch.')
  }
  // Never let an input adapter silently reinterpret ordering for a pinned choice.
  // Target controls use their immutable per-target source order.
  const interaction = question.interaction
  if (order && 'options' in interaction && !same(interaction.options.map((option) => option.id), order)) {
    throw new TypeError('Question option order does not match the pinned batch.')
  }
  return question
}

export function candidateValidators(source: FoundationSource) {
  const { batch, attemptId } = source
  const expected = createAttempt({ id: attemptId, cycleId: batch.cycleId, batch, optionOrder: batch.optionOrder })
  return {
    validateAttempt(attempt: CandidateSnapshot) {
      if (!isAttemptSnapshot(attempt) || attempt.id !== attemptId || attempt.cycleId !== batch.cycleId
        || !same(attempt.batch, expected.batch) || !same(attempt.optionOrder, expected.optionOrder)
        || attempt.status === 'SCORED' || attempt.result !== null
        || (attempt.status === 'SUBMITTED') !== (attempt.submittedAt !== null)
        || (attempt.candidateView !== 'question' && attempt.candidateView !== 'review')
        || (attempt.candidateView === 'review' && attempt.activeSection === null)) return false
      return Object.entries(attempt.answers).every(([id, answer]) =>
        isCandidateAnswerFor(candidateQuestion(source, id).interaction, answer))
    },
    validateCycle(cycle: CandidateCycle) {
      if (cycle.id !== batch.cycleId || cycle.contentVersion !== batch.contentVersion || !isCycleLifecycle(cycle.lifecycle)) return false
      const active = activeExamCycle(cycle.lifecycle)
      return active.id === cycle.id && active.bankVersion === cycle.contentVersion
        && active.batches.some((record) => samePinnedPlan(record.batch, batch))
    },
    validatePair(attempt: CandidateSnapshot, cycle: CandidateCycle) {
      const status = attempt.status === 'CREATED' || attempt.status === 'READY' ? 'GENERATED'
        : attempt.status === 'SUBMITTED' ? 'COMPLETED' : 'STARTED'
      return activeExamCycle(cycle.lifecycle).batches.find(({ batch: plan }) => plan.id === batch.id)?.status === status
    },
  }
}

type CandidateEdit = Exclude<FoundationAction, { type: 'TAKE_OVER' | 'RETRY_SAVE' | 'DISCARD_UNSAVED' }>
type CandidateChange = { readonly attempt: CandidateSnapshot; readonly cycle: CandidateCycle }

export function isRecoveryAction(action: FoundationAction): action is Exclude<FoundationAction, CandidateEdit> {
  return action.type === 'TAKE_OVER' || action.type === 'RETRY_SAVE' || action.type === 'DISCARD_UNSAVED'
}

/** Snapshot the deliberate action as one CAS. Section lock + next section
 * cannot be torn apart by quota errors, reloads, or a second tab. */
export function candidateChange(
  previous: CandidateSnapshot,
  cycle: CandidateCycle,
  source: FoundationSource,
  action: CandidateEdit | { type: 'RESUME_BOUNDARY' },
  at: number,
): CandidateChange | null {
  if (previous.status === 'SUBMITTED' || previous.revision >= Number.MAX_SAFE_INTEGER) return null
  const now = Math.max(at, previous.updatedAt ?? 0, cycle.lifecycle.updatedAt)
  let attempt: ExamAttempt = previous
  let nextCycle = cycle
  let view = previous.candidateView
  const apply = (event: AttemptEvent) => {
    const moved = transitionAttempt(attempt, { ...event, at: now })
    if (!moved.ok) return false
    attempt = moved.attempt
    return true
  }
  const track = (type: 'START' | 'COMPLETE') => {
    const tracked = transitionCycleLifecycle(cycle.lifecycle, { type, batchId: source.batch.id, at: now })
    if (!tracked.ok) return false
    nextCycle = { ...cycle, lifecycle: tracked.state }
    return true
  }
  const section = candidateSection(previous)
  const sectionId = section ? examSectionKey(section) : undefined
  const continueAfterSubmit = () => apply({
    type: nextExistingSection(attempt) ? 'START_SECTION' : 'OPEN_FINAL_REVIEW',
  })
  const activePosition = section?.questionIds[previous.position]
  if ('sectionId' in action && action.sectionId !== undefined && sectionId !== action.sectionId) return null
  switch (action.type) {
    case 'START':
      if (previous.status !== 'CREATED' && previous.status !== 'READY') return null
      if ((previous.status === 'CREATED' && !apply({ type: 'PREPARE' }))
        || !apply({ type: 'START_SECTION' }) || !track('START')) return null
      break
    case 'NAVIGATE':
      if (!apply({ type: 'NAVIGATE', position: action.position })) return null
      view = 'question'
      break
    case 'ANSWER':
      if (view !== 'question' || action.questionId !== activePosition) return null
      if (!apply({ type: 'SAVE_ANSWER', questionId: action.questionId,
        answer: toCandidateAnswer(candidateQuestion(source, action.questionId).interaction, action.response, previous.answers[action.questionId]),
      })) return null
      break
    case 'TOGGLE_MARK':
      if (!apply({ type: 'TOGGLE_REVIEW', questionId: action.questionId })) return null
      break
    case 'OPEN_REVIEW':
    case 'CLOSE_REVIEW':
      if (!section) return null
      view = action.type === 'OPEN_REVIEW' ? 'review' : 'question'
      if (view === previous.candidateView) return null
      break
    case 'SUBMIT_SECTION':
      if (!sectionId || !apply({ type: 'SUBMIT_SECTION', section: sectionId })) return null
      view = 'question'
      if (!continueAfterSubmit()) return null
      break
    case 'FINAL_SUBMIT':
      if (!apply({ type: 'FINAL_SUBMIT' }) || !track('COMPLETE')) return null
      if (source.eligibleSourceIds?.length) {
        const active = activeExamCycle(nextCycle.lifecycle)
        const universe = new Set(source.eligibleSourceIds)
        if (universe.size === source.eligibleSourceIds.length
          && universe.size === active.consumedSourceIds.length
          && active.consumedSourceIds.every((key) => universe.has(key))) {
          const exhausted = transitionCycleLifecycle(nextCycle.lifecycle, {
            type: 'COMPLETE_CYCLE', unusedEligibleSourceIds: [], at: now,
          })
          if (!exhausted.ok) return null
          nextCycle = { ...nextCycle, lifecycle: exhausted.state }
        }
      }
      break
    case 'RESUME_BOUNDARY':
      if (!atSubmittedSectionBoundary(previous) || !continueAfterSubmit()) return null
      break
  }
  return {
    attempt: withCursor({ ...attempt, updatedAt: now, revision: previous.revision + 1 }, view),
    cycle: nextCycle,
  }
}

export function atIntermediateBoundary(attempt: CandidateSnapshot): boolean {
  return atSubmittedSectionBoundary(attempt)
}
