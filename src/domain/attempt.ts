import { NORMAL_QUESTION_COUNT, NORMAL_SECTIONS } from './model'
import type {
  AttemptStatus,
  CandidateAnswer,
  CandidateInteractionAnswer,
  ExamAttempt,
  ExamBatch,
  ExamResult,
  ExamSectionKind,
  SourceQuestionId,
} from './model'

export type BatchFailure =
  | 'INVALID_BATCH'
  | 'SECTION_ORDER'
  | 'SECTION_CARDINALITY'
  | 'CASE_STUDY_ID'
  | 'QUESTION_ID'
  | 'DUPLICATE_QUESTION'

export type BatchValidation = { readonly ok: true } | { readonly ok: false; readonly reason: BatchFailure }

type TransitionFailure =
  | 'INVALID_TRANSITION'
  | 'SECTION_MISMATCH'
  | 'INVALID_POSITION'
  | 'QUESTION_NOT_IN_ACTIVE_SECTION'
  | 'INVALID_ANSWER'
  | 'INVALID_RESULT'
  | 'INVALID_TIMESTAMP'

export type TransitionResult =
  | { readonly ok: true; readonly attempt: ExamAttempt }
  | { readonly ok: false; readonly reason: TransitionFailure }

export type AttemptEvent = {
  readonly at?: number
} & (
  | { readonly type: 'PREPARE' | 'START_SECTION' | 'OPEN_FINAL_REVIEW' | 'FINAL_SUBMIT' }
  | { readonly type: 'NAVIGATE'; readonly position: number }
  | { readonly type: 'SAVE_ANSWER'; readonly questionId: SourceQuestionId; readonly answer: CandidateAnswer | null }
  | { readonly type: 'TOGGLE_REVIEW'; readonly questionId: SourceQuestionId }
  | { readonly type: 'SUBMIT_SECTION'; readonly section: ExamSectionKind }
  | { readonly type: 'RECORD_RESULT'; readonly result: ExamResult }
)

const stages = [
  { kind: 'CASE_STUDY_1', input: 'READY', progress: 'CASE_STUDY_1_IN_PROGRESS', submitted: 'CASE_STUDY_1_SUBMITTED' },
  { kind: 'CASE_STUDY_2', input: 'CASE_STUDY_1_SUBMITTED', progress: 'CASE_STUDY_2_IN_PROGRESS', submitted: 'CASE_STUDY_2_SUBMITTED' },
  { kind: 'STANDARD_BLOCK', input: 'CASE_STUDY_2_SUBMITTED', progress: 'STANDARD_BLOCK_IN_PROGRESS', submitted: 'STANDARD_BLOCK_SUBMITTED' },
  { kind: 'FINAL_INTERACTIVE_BLOCK', input: 'STANDARD_BLOCK_SUBMITTED', progress: 'INTERACTIVE_BLOCK_IN_PROGRESS', submitted: 'INTERACTIVE_BLOCK_SUBMITTED' },
] as const satisfies readonly {
  readonly kind: ExamSectionKind
  readonly input: AttemptStatus
  readonly progress: AttemptStatus
  readonly submitted: AttemptStatus
}[]

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function listOfIds(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false
  // Array.every skips sparse positions, but a persisted missing ID is not valid.
  return Array.from(value).every(id)
}

function uniqueIdList(value: unknown): value is readonly string[] {
  return listOfIds(value) && new Set(value).size === value.length
}

export function validateNormalBatch(batch: ExamBatch): BatchValidation {
  if (!record(batch) || !id(batch.id) || !id(batch.contentVersion)
    || !((typeof batch.seed === 'string' && batch.seed.length > 0)
      || (typeof batch.seed === 'number' && Number.isFinite(batch.seed)))
    || (batch.mode !== undefined && !['REFERENCE', 'DEVELOPMENT', 'PRODUCTION'].includes(batch.mode))
    || !Array.isArray(batch.sections)) {
    return { ok: false, reason: 'INVALID_BATCH' }
  }
  if (batch.sections.length !== NORMAL_SECTIONS.length) return { ok: false, reason: 'SECTION_ORDER' }
  const questionIds = new Set<SourceQuestionId>()
  const caseIds = new Set<string>()
  for (const [index, policy] of NORMAL_SECTIONS.entries()) {
    const section = batch.sections[index]
    if (!record(section) || section.kind !== policy.kind) return { ok: false, reason: 'SECTION_ORDER' }
    if (!Array.isArray(section.questionIds) || section.questionIds.length !== policy.count) {
      return { ok: false, reason: 'SECTION_CARDINALITY' }
    }
    if (index < 2) {
      if (!id(section.caseStudyId) || caseIds.has(section.caseStudyId)) return { ok: false, reason: 'CASE_STUDY_ID' }
      caseIds.add(section.caseStudyId)
    } else if (section.caseStudyId !== undefined) {
      return { ok: false, reason: 'CASE_STUDY_ID' }
    }
    for (const questionId of section.questionIds) {
      if (!id(questionId)) return { ok: false, reason: 'QUESTION_ID' }
      if (questionIds.has(questionId)) return { ok: false, reason: 'DUPLICATE_QUESTION' }
      questionIds.add(questionId)
    }
  }
  return { ok: true }
}

function copyBatch(batch: ExamBatch): ExamBatch {
  return Object.freeze({
    id: batch.id,
    contentVersion: batch.contentVersion,
    seed: batch.seed,
    ...(batch.mode === undefined ? {} : { mode: batch.mode }),
    sections: Object.freeze(batch.sections.map(({ kind, questionIds, caseStudyId }) => Object.freeze({
      kind,
      questionIds: Object.freeze([...questionIds]),
      ...(caseStudyId === undefined ? {} : { caseStudyId }),
    }))),
  })
}

function hasOnlyBatchIds(options: Readonly<Record<string, unknown>>, batch: ExamBatch): boolean {
  const questionIds = new Set(batch.sections.flatMap((section) => section.questionIds))
  return Object.keys(options).every((questionId) => questionIds.has(questionId))
}

export function createAttempt(input: {
  readonly id: string
  readonly cycleId: string
  readonly batch: ExamBatch
  readonly optionOrder?: Readonly<Partial<Record<SourceQuestionId, readonly string[]>>>
  readonly at?: number
}): ExamAttempt {
  const valid = validateNormalBatch(input.batch)
  if (!valid.ok) throw new Error(`Invalid normal exam batch: ${valid.reason}`)
  if (!id(input.id) || !id(input.cycleId)) throw new Error('Attempt and cycle IDs are required')
  if (input.at !== undefined && !isTimestamp(input.at)) throw new Error('Invalid attempt timestamp')
  const options = input.optionOrder ?? {}
  if (!record(options) || !hasOnlyBatchIds(options, input.batch)) throw new Error('Invalid option order question IDs')
  const optionOrder = Object.freeze(Object.fromEntries(Object.entries(options).map(([key, values]) => {
    if (!uniqueIdList(values)) throw new Error('Invalid option order')
    return [key, Object.freeze([...values])]
  })))
  return Object.freeze({
    id: input.id,
    cycleId: input.cycleId,
    batch: copyBatch(input.batch),
    contentVersion: input.batch.contentVersion,
    revision: 0,
    status: 'CREATED',
    activeSection: null,
    position: 0,
    locks: Object.freeze([]),
    answers: Object.freeze({}),
    reviewMarks: Object.freeze({}),
    optionOrder,
    updatedAt: input.at ?? null,
    submittedAt: null,
    result: null,
  })
}

function validAnswer(value: unknown, allowDiagram = true): value is CandidateAnswer {
  if (!record(value) || typeof value.kind !== 'string') return false
  switch (value.kind) {
    case 'SINGLE_CHOICE':
      return id(value.optionId)
    case 'MULTIPLE_CHOICE':
    case 'ORDERING':
      return uniqueIdList(value.optionIds)
    case 'DROPDOWN':
    case 'DROPDOWN_HOTSPOT':
    case 'MATCHING':
    case 'DRAG_DROP':
    case 'STATEMENT':
      return record(value.selections)
        && Object.entries(value.selections).every(([key, optionId]) => id(key) && id(optionId))
    case 'IMAGE_HOTSPOT':
      return uniqueIdList(value.regionIds)
    case 'DIAGRAM_DEPENDENT':
      return allowDiagram && validAnswer(value.response, false)
    default:
      return false
  }
}

function copyInteractionAnswer(answer: CandidateInteractionAnswer): CandidateInteractionAnswer {
  switch (answer.kind) {
    case 'SINGLE_CHOICE':
      return Object.freeze({ kind: answer.kind, optionId: answer.optionId })
    case 'MULTIPLE_CHOICE':
    case 'ORDERING':
      return Object.freeze({ kind: answer.kind, optionIds: Object.freeze([...answer.optionIds]) })
    case 'DROPDOWN':
    case 'DROPDOWN_HOTSPOT':
    case 'MATCHING':
    case 'DRAG_DROP':
    case 'STATEMENT':
      return Object.freeze({ kind: answer.kind, selections: Object.freeze({ ...answer.selections }) })
    case 'IMAGE_HOTSPOT':
      return Object.freeze({ kind: answer.kind, regionIds: Object.freeze([...answer.regionIds]) })
  }
}

function copyAnswer(answer: CandidateAnswer): CandidateAnswer {
  if (answer.kind === 'DIAGRAM_DEPENDENT') {
    return Object.freeze({ kind: answer.kind, response: copyInteractionAnswer(answer.response) })
  }
  return copyInteractionAnswer(answer)
}

function validResult(result: unknown): result is ExamResult {
  return record(result)
    && result.questionCount === NORMAL_QUESTION_COUNT
    && typeof result.correctCount === 'number' && Number.isInteger(result.correctCount)
    && result.correctCount >= 0 && result.correctCount <= NORMAL_QUESTION_COUNT
    && typeof result.percentage === 'number' && Number.isFinite(result.percentage)
    && result.percentage >= 0 && result.percentage <= 100
    && (result.scoringPolicyVersion === undefined || id(result.scoringPolicyVersion))
}

function hasExpectedLocks(locks: readonly string[], count: number): boolean {
  return locks.length === count && locks.every((kind, index) => kind === stages[index]?.kind)
}

function fail(reason: TransitionFailure): TransitionResult {
  return { ok: false, reason }
}

/** Domain does not mutate input or persist it; the storage adapter commits a successful candidate. */
export function transitionAttempt(attempt: ExamAttempt, event: AttemptEvent): TransitionResult {
  if (event.at !== undefined && !isTimestamp(event.at)) return fail('INVALID_TIMESTAMP')
  const next = (patch: Partial<ExamAttempt>): TransitionResult => ({
    ok: true,
    attempt: Object.freeze({
      ...attempt,
      ...patch,
      revision: attempt.revision + 1,
      updatedAt: event.at ?? attempt.updatedAt,
    }),
  })
  const stageIndex = stages.findIndex(({ progress, kind }) => attempt.status === progress && attempt.activeSection === kind)
  const stage = stages[stageIndex]
  const section = stage && hasExpectedLocks(attempt.locks, stageIndex)
    ? attempt.batch.sections.find(({ kind }) => kind === stage.kind)
    : undefined

  switch (event.type) {
    case 'PREPARE':
      return attempt.status === 'CREATED' ? next({ status: 'READY' }) : fail('INVALID_TRANSITION')
    case 'START_SECTION': {
      const nextIndex = stages.findIndex(({ input }) => input === attempt.status)
      const subsequent = stages[nextIndex]
      if (!subsequent || attempt.activeSection !== null || !hasExpectedLocks(attempt.locks, nextIndex)) {
        return fail('INVALID_TRANSITION')
      }
      return next({ status: subsequent.progress, activeSection: subsequent.kind, position: 0 })
    }
    case 'NAVIGATE':
      if (!section) return fail('INVALID_TRANSITION')
      if (!Number.isInteger(event.position) || event.position < 0 || event.position >= section.questionIds.length) {
        return fail('INVALID_POSITION')
      }
      return next({ position: event.position })
    case 'SAVE_ANSWER': {
      if (!section) return fail('INVALID_TRANSITION')
      if (!section.questionIds.includes(event.questionId)) return fail('QUESTION_NOT_IN_ACTIVE_SECTION')
      if (event.answer !== null && !validAnswer(event.answer)) return fail('INVALID_ANSWER')
      const answers = { ...attempt.answers }
      if (event.answer === null) delete answers[event.questionId]
      else Object.defineProperty(answers, event.questionId, { value: copyAnswer(event.answer), enumerable: true })
      return next({ answers: Object.freeze(answers) })
    }
    case 'TOGGLE_REVIEW': {
      if (!section) return fail('INVALID_TRANSITION')
      if (!section.questionIds.includes(event.questionId)) return fail('QUESTION_NOT_IN_ACTIVE_SECTION')
      const reviewMarks = { ...attempt.reviewMarks }
      if (reviewMarks[event.questionId] === true) delete reviewMarks[event.questionId]
      else Object.defineProperty(reviewMarks, event.questionId, { value: true, enumerable: true })
      return next({ reviewMarks: Object.freeze(reviewMarks) })
    }
    case 'SUBMIT_SECTION':
      if (!stage || !section) return fail('INVALID_TRANSITION')
      if (stage.kind !== event.section) return fail('SECTION_MISMATCH')
      return next({
        status: stage.submitted,
        activeSection: null,
        position: 0,
        locks: Object.freeze([...attempt.locks, stage.kind]),
      })
    case 'OPEN_FINAL_REVIEW':
      return attempt.status === 'INTERACTIVE_BLOCK_SUBMITTED' && hasExpectedLocks(attempt.locks, stages.length)
        ? next({ status: 'FINAL_SUBMISSION_PENDING' })
        : fail('INVALID_TRANSITION')
    case 'FINAL_SUBMIT':
      if (attempt.status === 'SUBMITTED' || attempt.status === 'SCORED') return { ok: true, attempt }
      return attempt.status === 'FINAL_SUBMISSION_PENDING' && hasExpectedLocks(attempt.locks, stages.length)
        ? next({ status: 'SUBMITTED', submittedAt: event.at ?? attempt.updatedAt })
        : fail('INVALID_TRANSITION')
    case 'RECORD_RESULT':
      if (attempt.status !== 'SUBMITTED') return fail('INVALID_TRANSITION')
      if (!validResult(event.result)) return fail('INVALID_RESULT')
      return next({
        status: 'SCORED',
        result: Object.freeze({
          correctCount: event.result.correctCount,
          questionCount: event.result.questionCount,
          percentage: event.result.percentage,
          ...(event.result.scoringPolicyVersion === undefined
            ? {} : { scoringPolicyVersion: event.result.scoringPolicyVersion }),
        }),
      })
    default:
      return fail('INVALID_TRANSITION')
  }
}

/** Structural and machine-invariant validation at the untrusted storage boundary. */
export function isAttemptSnapshot(value: unknown): value is ExamAttempt {
  if (!record(value) || !id(value.id) || !id(value.cycleId) || !record(value.batch)
    || !validateNormalBatch(value.batch as unknown as ExamBatch).ok
    || value.contentVersion !== value.batch.contentVersion
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.position !== 'number' || !Number.isInteger(value.position) || value.position < 0
    || !uniqueIdList(value.locks) || !record(value.answers) || !record(value.reviewMarks) || !record(value.optionOrder)
    || !(value.updatedAt === null || isTimestamp(value.updatedAt))
    || !(value.submittedAt === null || isTimestamp(value.submittedAt))) return false
  const batch = value.batch as unknown as ExamBatch
  if (!hasOnlyBatchIds(value.answers, batch) || !hasOnlyBatchIds(value.reviewMarks, batch)
    || !hasOnlyBatchIds(value.optionOrder, batch)
    || !Object.values(value.answers).every((answer) => validAnswer(answer))
    || !Object.values(value.reviewMarks).every((mark) => typeof mark === 'boolean')
    || !Object.values(value.optionOrder).every(uniqueIdList)) return false
  const progress = stages.findIndex(({ progress }) => progress === value.status)
  const submitted = stages.findIndex(({ submitted }) => submitted === value.status)
  const isSubmitted = value.status === 'SUBMITTED' || value.status === 'SCORED'
  const isFinal = isSubmitted || value.status === 'FINAL_SUBMISSION_PENDING'
  const beforeStart = value.status === 'CREATED' || value.status === 'READY'
  if (progress < 0 && submitted < 0 && !isFinal && !beforeStart) return false
  const lockCount = progress >= 0 ? progress : submitted >= 0 ? submitted + 1 : isFinal ? stages.length : 0
  if (!hasExpectedLocks(value.locks, lockCount)) return false
  if (!isSubmitted && value.submittedAt !== null) return false
  if (value.status === 'SCORED' ? !validResult(value.result) : value.result !== null) return false
  // Previous/current sections may have content; later sections may not.
  const touchedIds = new Set(batch.sections.slice(0, lockCount + (progress >= 0 ? 1 : 0))
    .flatMap(({ questionIds }) => questionIds))
  if (![...Object.keys(value.answers), ...Object.keys(value.reviewMarks)].every((id) => touchedIds.has(id))) return false
  return progress >= 0
    ? value.activeSection === stages[progress]?.kind && value.position < (batch.sections[progress]?.questionIds.length ?? 0)
    : value.activeSection === null && value.position === 0
}
