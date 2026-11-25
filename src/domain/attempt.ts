import { NORMAL_QUESTION_COUNT, NORMAL_SECTIONS } from './model'
import { examExpirationAt, isExamTimestamp } from './exam-timer'
import type {
  AttemptStatus,
  CandidateAnswer,
  CandidateInteractionAnswer,
  ExamAttempt,
  ExamBatch,
  ExamFinalizationReason,
  ExamInteractionKinds,
  ExamResult,
  ExamSection,
  ExamSectionKey,
  ExamSectionKind,
  FinalizedAnswerSnapshot,
  PinnedFinalizedAnswerSnapshot,
  ScoreCounts,
  ScoredExamResult,
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
  | 'INVALID_DURATION'
  | 'TIME_EXPIRED'
  | 'DEADLINE_NOT_REACHED'

export type TransitionResult =
  | { readonly ok: true; readonly attempt: ExamAttempt }
  | { readonly ok: false; readonly reason: TransitionFailure }

export type AttemptEvent = {
  readonly at?: number
} & (
  | { readonly type: 'PREPARE' | 'OPEN_FINAL_REVIEW' | 'FINAL_SUBMIT' | 'END_EXAM' }
  | { readonly type: 'START_SECTION'; readonly durationMinutes?: number }
  | { readonly type: 'TIME_EXPIRED'; readonly at: number }
  | { readonly type: 'NAVIGATE'; readonly position: number }
  | { readonly type: 'SAVE_ANSWER'; readonly questionId: SourceQuestionId; readonly answer: CandidateAnswer | null }
  | { readonly type: 'TOGGLE_REVIEW'; readonly questionId: SourceQuestionId }
  | { readonly type: 'SUBMIT_SECTION'; readonly section: ExamSectionKey }
  | { readonly type: 'RECORD_RESULT'; readonly result: ExamResult }
)

const stages = {
  CASE_STUDY_1: { progress: 'CASE_STUDY_1_IN_PROGRESS', submitted: 'CASE_STUDY_1_SUBMITTED' },
  CASE_STUDY_2: { progress: 'CASE_STUDY_2_IN_PROGRESS', submitted: 'CASE_STUDY_2_SUBMITTED' },
  REMAINDER_CASE_STUDY: { progress: 'REMAINDER_CASE_STUDY_IN_PROGRESS', submitted: 'REMAINDER_CASE_STUDY_SUBMITTED' },
  STANDARD_BLOCK: { progress: 'STANDARD_BLOCK_IN_PROGRESS', submitted: 'STANDARD_BLOCK_SUBMITTED' },
  REMAINDER_UNSECTIONED: { progress: 'REMAINDER_UNSECTIONED_IN_PROGRESS', submitted: 'REMAINDER_UNSECTIONED_SUBMITTED' },
  FINAL_INTERACTIVE_BLOCK: { progress: 'INTERACTIVE_BLOCK_IN_PROGRESS', submitted: 'INTERACTIVE_BLOCK_SUBMITTED' },
} as const satisfies Record<ExamSectionKind, { readonly progress: AttemptStatus; readonly submitted: AttemptStatus }>

/** Normal section keys retain their original persisted representation.
 * A variable case section is keyed by its actual source family, not its label
 * or its shared kind, so two real case sections cannot reopen one another. */
export function examSectionKey(section: ExamSection): ExamSectionKey {
  return section.kind === 'REMAINDER_CASE_STUDY' ? `REMAINDER_CASE_STUDY:${section.caseStudyId!}` : section.kind
}

export function nextExistingSection(attempt: Pick<ExamAttempt, 'batch' | 'locks'>): ExamSection | undefined {
  return attempt.batch.sections[attempt.locks.length]
}

export function atSubmittedSectionBoundary(attempt: Pick<ExamAttempt, 'batch' | 'locks' | 'activeSection' | 'status'>): boolean {
  const previous = attempt.batch.sections[attempt.locks.length - 1]
  return attempt.activeSection === null && Boolean(previous && stages[previous.kind].submitted === attempt.status)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function isTimestamp(value: unknown): value is number {
  return isExamTimestamp(value)
}

function listOfIds(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false
  // Array.every skips sparse positions, but a persisted missing ID is not valid.
  return Array.from(value).every(id)
}

function uniqueIdList(value: unknown): value is readonly string[] {
  return listOfIds(value) && new Set(value).size === value.length
}

function validBatchEnvelope(batch: ExamBatch): boolean {
  return !(!record(batch) || !id(batch.id) || !id(batch.contentVersion)
    || !((typeof batch.seed === 'string' && batch.seed.length > 0)
      || (typeof batch.seed === 'number' && Number.isFinite(batch.seed)))
    || (batch.mode !== undefined && !['REFERENCE', 'DEVELOPMENT', 'PRODUCTION'].includes(batch.mode))
    || !Array.isArray(batch.sections))
}

export function validateNormalBatch(batch: ExamBatch): BatchValidation {
  if (!validBatchEnvelope(batch) || (batch.batchMode !== undefined && batch.batchMode !== 'NORMAL')) {
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

/** Validate presentation independently of generation/inventory. An older plan
 * without an explicit mode can only represent the original normal format. */
export function validateExamBatch(batch: ExamBatch): BatchValidation {
  if (!validBatchEnvelope(batch)) return { ok: false, reason: 'INVALID_BATCH' }
  if (batch.batchMode === undefined || batch.batchMode === 'NORMAL') return validateNormalBatch(batch)
  if (batch.batchMode !== 'ADAPTIVE' && batch.batchMode !== 'FINAL_REMAINDER') return { ok: false, reason: 'INVALID_BATCH' }

  const order = new Map<ExamSectionKind, number>([
    ['REMAINDER_CASE_STUDY', 0], ['STANDARD_BLOCK', 1], ['REMAINDER_UNSECTIONED', 2], ['FINAL_INTERACTIVE_BLOCK', 3],
  ])
  const caseIds = new Set<string>()
  const questionIds = new Set<SourceQuestionId>()
  let previousRank = -1
  for (const section of Array.from(batch.sections)) {
    if (!record(section)) return { ok: false, reason: 'SECTION_ORDER' }
    const rank = order.get(section.kind)
    if (rank === undefined || rank < previousRank || (rank === previousRank && section.kind !== 'REMAINDER_CASE_STUDY')) {
      return { ok: false, reason: 'SECTION_ORDER' }
    }
    if (section.kind === 'REMAINDER_CASE_STUDY') {
      if (!id(section.caseStudyId) || caseIds.has(section.caseStudyId)) return { ok: false, reason: 'CASE_STUDY_ID' }
      caseIds.add(section.caseStudyId)
    } else if (section.caseStudyId !== undefined) {
      return { ok: false, reason: 'CASE_STUDY_ID' }
    }
    if (!Array.isArray(section.questionIds) || section.questionIds.length === 0) {
      return { ok: false, reason: 'SECTION_CARDINALITY' }
    }
    for (const questionId of section.questionIds) {
      if (!id(questionId)) return { ok: false, reason: 'QUESTION_ID' }
      if (questionIds.has(questionId)) return { ok: false, reason: 'DUPLICATE_QUESTION' }
      questionIds.add(questionId)
    }
    previousRank = rank
  }
  // Inventory and the persisted generated plan establish that a final is
  // genuinely all remaining items. Presentation itself has no 59-item cap.
  if (batch.batchMode === 'ADAPTIVE' ? questionIds.size !== NORMAL_QUESTION_COUNT : questionIds.size === 0) {
    return { ok: false, reason: 'SECTION_CARDINALITY' }
  }
  return { ok: true }
}

function copySections(sections: readonly ExamSection[]): readonly ExamSection[] {
  return Object.freeze(sections.map(({ kind, questionIds, caseStudyId }) => Object.freeze({
    kind,
    questionIds: Object.freeze([...questionIds]),
    ...(caseStudyId === undefined ? {} : { caseStudyId }),
  })))
}

function copyBatch(batch: ExamBatch): ExamBatch {
  return Object.freeze({
    id: batch.id,
    contentVersion: batch.contentVersion,
    seed: batch.seed,
    ...(batch.mode === undefined ? {} : { mode: batch.mode }),
    // Canonical Phase 5 snapshots predate batchMode. Keep their persisted
    // projection byte-for-byte compatible while pinning every variable plan.
    ...(batch.batchMode === undefined || batch.batchMode === 'NORMAL' ? {} : { batchMode: batch.batchMode }),
    sections: copySections(batch.sections),
  })
}

function hasOnlyBatchIds(options: Readonly<Record<string, unknown>>, batch: ExamBatch): boolean {
  const questionIds = new Set(batch.sections.flatMap((section) => section.questionIds))
  return Object.keys(options).every((questionId) => questionIds.has(questionId))
}

const knownInteractions = new Set([
  'SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'DROPDOWN', 'MATCHING', 'DRAG_DROP', 'ORDERING',
  'STATEMENT', 'DROPDOWN_HOTSPOT', 'IMAGE_HOTSPOT', 'DIAGRAM_DEPENDENT',
])

function validInteractionKinds(kinds: unknown, questionIds: readonly string[]): kinds is ExamInteractionKinds {
  return record(kinds) && Object.keys(kinds).length === questionIds.length && questionIds.every((sourceId) =>
    Object.hasOwn(kinds, sourceId) && typeof kinds[sourceId] === 'string' && knownInteractions.has(kinds[sourceId]))
}

export function createAttempt(input: {
  readonly id: string
  readonly cycleId: string
  readonly batch: ExamBatch
  readonly optionOrder?: Readonly<Partial<Record<SourceQuestionId, readonly string[]>>>
  readonly interactionKinds?: ExamInteractionKinds
  readonly at?: number
}): ExamAttempt {
  const valid = validateExamBatch(input.batch)
  if (!valid.ok) throw new Error(`Invalid exam batch: ${valid.reason}`)
  if (!id(input.id) || !id(input.cycleId)) throw new Error('Attempt and cycle IDs are required')
  if (input.at !== undefined && !isTimestamp(input.at)) throw new Error('Invalid attempt timestamp')
  const options = input.optionOrder ?? {}
  if (!record(options) || !hasOnlyBatchIds(options, input.batch)) throw new Error('Invalid option order question IDs')
  const optionOrder = Object.freeze(Object.fromEntries(Object.entries(options).map(([key, values]) => {
    if (!uniqueIdList(values)) throw new Error('Invalid option order')
    return [key, Object.freeze([...values])]
  })))
  const interactionKinds = input.interactionKinds
  if (interactionKinds !== undefined && !validInteractionKinds(interactionKinds, input.batch.sections.flatMap((section) => section.questionIds))) {
    throw new TypeError('Invalid pinned question interaction types')
  }
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
    ...(interactionKinds === undefined ? {} : { interactionKinds: Object.freeze({ ...interactionKinds }) }),
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

function phase6FinalizedAnswers(attempt: ExamAttempt, submittedAt: number, reason: ExamFinalizationReason): FinalizedAnswerSnapshot {
  const answers = Object.freeze(Object.fromEntries(Object.entries(attempt.answers).map(([key, answer]) => [key, copyAnswer(answer!)])))
  return Object.freeze({
    attemptId: attempt.id,
    cycleId: attempt.cycleId,
    batchId: attempt.batch.id,
    contentVersion: attempt.contentVersion,
    questionIds: Object.freeze(attempt.batch.sections.flatMap(section => section.questionIds)),
    submittedAt,
    reason,
    answers,
  })
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (record(value)) {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

/** A local deterministic identifier, not an authenticity claim. Source and
 * exact payload checks still apply; no browser-only record is tamper-proof. */
function finalizedIdentity(payload: Omit<PinnedFinalizedAnswerSnapshot, 'snapshotId'>): string {
  let hash = 0xcbf29ce484222325n
  const raw = canonical(payload)
  for (let i = 0; i < raw.length; i += 1) hash = BigInt.asUintN(64, (hash ^ BigInt(raw.charCodeAt(i))) * 0x100000001b3n)
  return 'answers-v2-' + hash.toString(16).padStart(16, '0')
}

function pinFinalized(
  base: FinalizedAnswerSnapshot, sections: readonly ExamSection[], kinds: ExamInteractionKinds,
): PinnedFinalizedAnswerSnapshot {
  const payload = {
    ...base,
    schemaVersion: 2 as const,
    bankVersion: base.contentVersion,
    finalizedAt: base.submittedAt,
    finalizationReason: base.reason,
    sections: copySections(sections),
    interactionKinds: Object.freeze({ ...kinds }),
  }
  return Object.freeze({ ...payload, snapshotId: finalizedIdentity(payload) })
}

function finalizedAnswers(
  attempt: ExamAttempt, submittedAt: number, reason: ExamFinalizationReason,
): FinalizedAnswerSnapshot | PinnedFinalizedAnswerSnapshot {
  const base = phase6FinalizedAnswers(attempt, submittedAt, reason)
  return attempt.interactionKinds ? pinFinalized(base, attempt.batch.sections, attempt.interactionKinds) : base
}

function samePlain(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && Array.from(left).every((item, index) => samePlain(item, right[index]))
  }
  if (!record(left) || !record(right)) return false
  const entries = Object.entries(left)
  return entries.length === Object.keys(right).length
    && entries.every(([key, item]) => Object.hasOwn(right, key) && samePlain(item, right[key]))
}

/** Validate even after JSON/structured clone; callers should take a frozen copy
 * from getPinnedFinalizedAnswerSnapshot before invoking scoring. */
export function isPinnedFinalizedAnswerSnapshot(value: unknown): value is PinnedFinalizedAnswerSnapshot {
  if (!record(value) || value.schemaVersion !== 2 || !id(value.attemptId) || !id(value.cycleId)
    || !id(value.batchId) || !id(value.contentVersion) || !id(value.snapshotId)
    || !isTimestamp(value.submittedAt) || value.finalizedAt !== value.submittedAt || value.bankVersion !== value.contentVersion
    || (value.reason !== 'MANUAL_SUBMISSION' && value.reason !== 'TIME_EXPIRED') || value.finalizationReason !== value.reason
    || !uniqueIdList(value.questionIds) || !Array.isArray(value.sections) || !record(value.answers)) return false
  const candidate: ExamBatch = {
    id: value.batchId, contentVersion: value.contentVersion, sections: value.sections, seed: 'snapshot-validation',
    batchMode: value.questionIds.length === NORMAL_QUESTION_COUNT ? 'ADAPTIVE' : 'FINAL_REMAINDER',
  }
  if (!validateNormalBatch({ ...candidate, batchMode: 'NORMAL' }).ok && !validateExamBatch(candidate).ok) return false
  const questionIds = candidate.sections.flatMap((item) => item.questionIds)
  if (!samePlain(questionIds, value.questionIds) || !validInteractionKinds(value.interactionKinds, questionIds)) return false
  const kinds = value.interactionKinds
  if (!hasOnlyBatchIds(value.answers, candidate) || !Object.entries(value.answers).every(([key, answer]) =>
    validAnswer(answer) && answer.kind === kinds[key])) return false
  const base: FinalizedAnswerSnapshot = {
    attemptId: value.attemptId, cycleId: value.cycleId, batchId: value.batchId, contentVersion: value.contentVersion,
    submittedAt: value.submittedAt, reason: value.reason, questionIds,
    answers: Object.fromEntries(Object.entries(value.answers).map(([key, answer]) => [key, copyAnswer(answer as CandidateAnswer)])),
  }
  return samePlain(value, pinFinalized(base, candidate.sections, kinds))
}

function validResult(result: unknown, actualQuestionCount: number): result is ExamResult {
  return record(result)
    && typeof result.questionCount === 'number' && Number.isInteger(result.questionCount)
    && result.questionCount > 0 && result.questionCount <= actualQuestionCount
    && typeof result.correctCount === 'number' && Number.isInteger(result.correctCount)
    && result.correctCount >= 0 && result.correctCount <= result.questionCount
    && typeof result.percentage === 'number' && Number.isFinite(result.percentage)
    && result.percentage >= 0 && result.percentage <= 100
    && (result.scoringPolicyVersion === undefined || id(result.scoringPolicyVersion))
}

const countKeys = ['correctCount', 'incorrectCount', 'unansweredCount', 'questionCount'] as const
const reviewPolicies = new Set(['NONE', 'RESPONSES_ONLY', 'CORRECTNESS', 'ANSWERS_AND_EXPLANATIONS'])

function exactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]) {
  return Reflect.ownKeys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key))
}

function validScoreCounts(value: unknown): value is Readonly<Record<string, unknown>> & ScoreCounts {
  if (!record(value) || !countKeys.every((key) =>
    typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0)) return false
  const counts = value as unknown as ScoreCounts
  return counts.correctCount + counts.incorrectCount + counts.unansweredCount === counts.questionCount
}

const scoredKeys = [
  ...countKeys, 'schemaVersion', 'attemptId', 'batchId', 'snapshotId', 'bankVersion', 'scoringVersion',
  'scoringPolicyVersion', 'rawScore', 'maximumScore', 'percentage', 'displayPercentage', 'passingPercentage',
  'outcome', 'completedAt', 'finalizationReason', 'postExamReviewPolicy', 'sectionBreakdown', 'interactionTypeBreakdown',
] as const

function sumsMatch(groups: readonly Record<string, unknown>[], counts: ScoreCounts): boolean {
  return countKeys.every((key) => groups.reduce((total, group) => total + Number(group[key]), 0) === counts[key])
}

/** Strict aggregate result, pinned to the exact local snapshot. This
 * validates accounting and metadata without recomputing correctness. */
export function isScoredExamResult(value: unknown, snapshot: PinnedFinalizedAnswerSnapshot): value is ScoredExamResult {
  if (!isPinnedFinalizedAnswerSnapshot(snapshot) || !validScoreCounts(value) || !exactKeys(value, scoredKeys)
    || value.schemaVersion !== 2 || value.attemptId !== snapshot.attemptId || value.batchId !== snapshot.batchId
    || value.snapshotId !== snapshot.snapshotId || value.bankVersion !== snapshot.bankVersion
    || !id(value.scoringVersion) || value.scoringPolicyVersion !== value.scoringVersion
    || value.completedAt !== snapshot.finalizedAt || value.finalizationReason !== snapshot.finalizationReason
    || typeof value.postExamReviewPolicy !== 'string' || !reviewPolicies.has(value.postExamReviewPolicy)
    || value.questionCount !== snapshot.questionIds.length || value.maximumScore !== value.questionCount
    || value.rawScore !== value.correctCount
    || typeof value.percentage !== 'number' || value.percentage !== (100 * value.correctCount) / value.questionCount
    || value.displayPercentage !== value.percentage.toFixed(2) + '%'
    || typeof value.passingPercentage !== 'number' || !Number.isFinite(value.passingPercentage)
    || value.passingPercentage < 0 || value.passingPercentage > 100
    || value.outcome !== (value.percentage >= value.passingPercentage ? 'PASS' : 'FAIL')
    || !Array.isArray(value.sectionBreakdown) || value.sectionBreakdown.length !== snapshot.sections.length
    || !Array.isArray(value.interactionTypeBreakdown)) return false
  const kindCounts = new Map<string, { total: number; unanswered: number }>()
  for (const key of snapshot.questionIds) {
    const kind = snapshot.interactionKinds[key]
    const prior = kindCounts.get(kind) ?? { total: 0, unanswered: 0 }
    kindCounts.set(kind, {
      total: prior.total + 1,
      unanswered: prior.unanswered + (Object.hasOwn(snapshot.answers, key) ? 0 : 1),
    })
  }
  const unseenKinds = new Set(kindCounts.keys())
  if (value.interactionTypeBreakdown.length !== unseenKinds.size
    || !Array.from(value.sectionBreakdown).every((part, index) => {
      const section = snapshot.sections[index]
      return validScoreCounts(part) && exactKeys(part, [
        ...countKeys, 'sectionId', 'sectionKind', ...(section.caseStudyId ? ['caseStudyId'] : []),
      ]) && part.sectionId === examSectionKey(section) && part.sectionKind === section.kind
        && part.caseStudyId === section.caseStudyId && part.questionCount === section.questionIds.length
        && part.unansweredCount === section.questionIds.filter((key) => !Object.hasOwn(snapshot.answers, key)).length
    }) || !Array.from(value.interactionTypeBreakdown).every((part) => {
      if (!validScoreCounts(part) || !exactKeys(part, [...countKeys, 'interactionKind'])
        || typeof part.interactionKind !== 'string' || !unseenKinds.delete(part.interactionKind)) return false
      const counts = kindCounts.get(part.interactionKind)!
      return part.questionCount === counts.total && part.unansweredCount === counts.unanswered
    })) return false
  return sumsMatch(value.sectionBreakdown, value) && sumsMatch(value.interactionTypeBreakdown, value)
}

function copyScoredResult(result: ScoredExamResult): ScoredExamResult {
  return Object.freeze({
    ...result,
    sectionBreakdown: Object.freeze(result.sectionBreakdown.map((item) => Object.freeze({ ...item }))),
    interactionTypeBreakdown: Object.freeze(result.interactionTypeBreakdown.map((item) => Object.freeze({ ...item }))),
  })
}

function isLegacyResult(result: unknown, actualQuestionCount: number): result is ExamResult {
  return validResult(result, actualQuestionCount) && Object.keys(result).every((key) =>
    ['correctCount', 'questionCount', 'percentage', 'scoringPolicyVersion'].includes(key))
}

function hasExpectedLocks(locks: readonly string[], sections: readonly ExamSection[]): boolean {
  return locks.length <= sections.length && locks.every((key, index) => key === examSectionKey(sections[index]))
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
      updatedAt: event.at === undefined ? attempt.updatedAt : Math.max(event.at, attempt.updatedAt ?? 0),
    }),
  })
  const sections = attempt.batch.sections
  const nextSection = nextExistingSection(attempt)
  const validLocks = hasExpectedLocks(attempt.locks, sections)
  const stage = nextSection ? stages[nextSection.kind] : undefined
  const section = stage && nextSection && validLocks && attempt.status === stage.progress
    && attempt.activeSection === examSectionKey(nextSection) ? nextSection : undefined
  const boundary = validLocks && atSubmittedSectionBoundary(attempt)
  const timed = typeof attempt.expiresAt === 'number'
  const isTerminal = attempt.status === 'SUBMITTED' || attempt.status === 'SCORED'
  const terminalEvent = event.type === 'END_EXAM' || event.type === 'FINAL_SUBMIT' || event.type === 'TIME_EXPIRED'
  if (isTerminal && terminalEvent) return { ok: true, attempt }
  // The caller supplies the *accepted* action time, not the delayed write time.
  // Once the cutoff is reached ordinary edits cannot be accepted in this domain.
  if (timed && !isTerminal) {
    if (event.at === undefined || (typeof attempt.startedAt === 'number' && event.at < attempt.startedAt)) {
      return fail('INVALID_TIMESTAMP')
    }
    if (!terminalEvent && event.at >= attempt.expiresAt!) return fail('TIME_EXPIRED')
  }

  switch (event.type) {
    case 'PREPARE':
      return attempt.status === 'CREATED' ? next({ status: 'READY' }) : fail('INVALID_TRANSITION')
    case 'START_SECTION': {
      if (!nextSection || !stage || attempt.activeSection !== null || !validLocks
        || (attempt.locks.length === 0 ? attempt.status !== 'READY' : !boundary)) {
        return fail('INVALID_TRANSITION')
      }
      const initial = attempt.locks.length === 0
      const { durationMinutes } = event
      if (!initial && durationMinutes !== undefined) return fail('INVALID_DURATION')
      if (durationMinutes !== undefined && event.at === undefined) return fail('INVALID_TIMESTAMP')
      const expiresAt = durationMinutes === undefined ? null : examExpirationAt(event.at!, durationMinutes)
      if (durationMinutes !== undefined && expiresAt === null) return fail('INVALID_DURATION')
      return next({
        status: stage.progress,
        activeSection: examSectionKey(nextSection),
        position: 0,
        ...(initial && event.at !== undefined ? { startedAt: event.at, expiresAt } : {}),
      })
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
      if (event.answer !== null && (!validAnswer(event.answer)
        || (attempt.interactionKinds && event.answer.kind !== attempt.interactionKinds[event.questionId]))) {
        return fail('INVALID_ANSWER')
      }
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
      if (examSectionKey(section) !== event.section) return fail('SECTION_MISMATCH')
      return next({
        status: stage.submitted,
        activeSection: null,
        position: 0,
        locks: Object.freeze([...attempt.locks, examSectionKey(section)]),
      })
    case 'OPEN_FINAL_REVIEW':
      return boundary && !nextSection
        ? next({ status: 'FINAL_SUBMISSION_PENDING' })
        : fail('INVALID_TRANSITION')
    case 'FINAL_SUBMIT':
    case 'END_EXAM':
    case 'TIME_EXPIRED': {
      const finalReview = attempt.status === 'FINAL_SUBMISSION_PENDING' && validLocks && !nextSection && attempt.activeSection === null
      if (event.type === 'FINAL_SUBMIT' ? !finalReview : !section && !boundary && !finalReview) {
        return fail('INVALID_TRANSITION')
      }
      const at = event.at ?? attempt.updatedAt
      if (!isTimestamp(at)) return fail('INVALID_TIMESTAMP')
      const expired = timed && at >= attempt.expiresAt!
      if (event.type === 'TIME_EXPIRED' && !expired) return fail('DEADLINE_NOT_REACHED')
      const reason: ExamFinalizationReason = expired ? 'TIME_EXPIRED' : 'MANUAL_SUBMISSION'
      const finalSnapshot = finalizedAnswers(attempt, at, reason)
      return next({
        status: 'SUBMITTED',
        activeSection: null,
        position: 0,
        locks: Object.freeze(sections.map(examSectionKey)),
        answers: finalSnapshot.answers,
        submittedAt: at,
        finalizationReason: reason,
        finalizedAnswerSnapshot: finalSnapshot,
      })
    }
    case 'RECORD_RESULT':
      if (attempt.status === 'SCORED') return samePlain(attempt.result, event.result) ? { ok: true, attempt } : fail('INVALID_RESULT')
      if (attempt.status !== 'SUBMITTED') return fail('INVALID_TRANSITION')
      {
        const snapshot = getFinalizedAnswerSnapshot(attempt)
        if (!snapshot) return fail('INVALID_TRANSITION')
        if (isPinnedFinalizedAnswerSnapshot(snapshot)) {
          if (!isScoredExamResult(event.result, snapshot)) return fail('INVALID_RESULT')
          return next({ status: 'SCORED', result: copyScoredResult(event.result) })
        }
      }
      if (!isLegacyResult(event.result, sections.reduce((count, item) => count + item.questionIds.length, 0))) return fail('INVALID_RESULT')
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
    || !validateExamBatch(value.batch as unknown as ExamBatch).ok
    || value.contentVersion !== value.batch.contentVersion
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.position !== 'number' || !Number.isInteger(value.position) || value.position < 0
    || !uniqueIdList(value.locks) || !record(value.answers) || !record(value.reviewMarks) || !record(value.optionOrder)
    || !(value.updatedAt === null || isTimestamp(value.updatedAt))
    || !(value.submittedAt === null || isTimestamp(value.submittedAt))) return false
  const batch = value.batch as unknown as ExamBatch
  const questionIds = batch.sections.flatMap((section) => section.questionIds)
  const kinds = value.interactionKinds
  if (kinds !== undefined && !validInteractionKinds(kinds, questionIds)) return false
  if (!hasOnlyBatchIds(value.answers, batch) || !hasOnlyBatchIds(value.reviewMarks, batch)
    || !hasOnlyBatchIds(value.optionOrder, batch)
    || !Object.entries(value.answers).every(([key, answer]) => validAnswer(answer) && (!kinds || answer.kind === kinds[key]))
    || !Object.values(value.reviewMarks).every((mark) => typeof mark === 'boolean')
    || !Object.values(value.optionOrder).every(uniqueIdList)) return false
  const sections = batch.sections
  const lockCount = value.locks.length
  if (!hasExpectedLocks(value.locks, sections)) return false
  const current = sections[lockCount]
  const last = sections[lockCount - 1]
  const progress = Boolean(current && stages[current.kind].progress === value.status)
  const submitted = Boolean(last && stages[last.kind].submitted === value.status)
  const isSubmitted = value.status === 'SUBMITTED' || value.status === 'SCORED'
  const isFinal = isSubmitted || value.status === 'FINAL_SUBMISSION_PENDING'
  const beforeStart = value.status === 'CREATED' || value.status === 'READY'
  if (!progress && !submitted && !isFinal && !beforeStart) return false
  if ((isFinal && lockCount !== sections.length) || (beforeStart && lockCount !== 0)) return false
  if (!isSubmitted && value.submittedAt !== null) return false
  // Legacy untimed attempts omit both fields. Do not create a deadline from the
  // currently loaded configuration when resuming a started legacy attempt.
  const { startedAt, expiresAt, finalizationReason, finalizedAnswerSnapshot } = value
  if (startedAt !== undefined || expiresAt !== undefined) {
    if ((startedAt !== null && !isTimestamp(startedAt)) || (expiresAt !== null && !isTimestamp(expiresAt))) return false
    if (beforeStart && (startedAt !== null || expiresAt !== null)) return false
    if (!beforeStart && !isTimestamp(startedAt)) return false
    if (isTimestamp(startedAt) && (!isTimestamp(value.updatedAt) || value.updatedAt < startedAt)) return false
    if (isTimestamp(expiresAt) && (!isTimestamp(startedAt) || expiresAt <= startedAt)) return false
    if (isTimestamp(expiresAt) && !isSubmitted && isTimestamp(value.updatedAt) && value.updatedAt >= expiresAt) return false
  }
  let strictFinal: FinalizedAnswerSnapshot | PinnedFinalizedAnswerSnapshot | undefined
  if (isSubmitted) {
    if (finalizationReason !== undefined || finalizedAnswerSnapshot !== undefined || startedAt !== undefined || kinds !== undefined) {
      if (!isTimestamp(value.submittedAt) || !isTimestamp(value.updatedAt) || value.updatedAt < value.submittedAt
        || (isTimestamp(startedAt) && value.submittedAt < startedAt)
        || (finalizationReason !== 'MANUAL_SUBMISSION' && finalizationReason !== 'TIME_EXPIRED')
        || (isTimestamp(expiresAt) && value.submittedAt >= expiresAt ? 'TIME_EXPIRED' : 'MANUAL_SUBMISSION') !== finalizationReason) {
        return false
      }
      strictFinal = finalizedAnswers(value as unknown as ExamAttempt, value.submittedAt, finalizationReason)
      if (!samePlain(finalizedAnswerSnapshot, strictFinal)) return false
    }
  } else if ((finalizationReason !== undefined && finalizationReason !== null)
    || (finalizedAnswerSnapshot !== undefined && finalizedAnswerSnapshot !== null)) return false
  if (value.status === 'SCORED') {
    if (strictFinal && 'schemaVersion' in strictFinal) {
      if (!isScoredExamResult(value.result, strictFinal)) return false
    } else if (!isLegacyResult(value.result, questionIds.length)) return false
  } else if (value.result !== null) return false
  // Previous/current sections may have content; later sections may not.
  const touchedIds = new Set(sections.slice(0, lockCount + (progress ? 1 : 0))
    .flatMap(({ questionIds }) => questionIds))
  if (![...Object.keys(value.answers), ...Object.keys(value.reviewMarks)].every((id) => touchedIds.has(id))) return false
  return progress
    ? value.activeSection === examSectionKey(current) && value.position < current.questionIds.length
    : value.activeSection === null && value.position === 0
}

/** Restore the frozen terminal projection after structured-clone storage; old
 * timestamped submitted attempts are provably manual and can be upgraded
 * without applying new timer configuration or reopening their locks. */
export function restoreAttemptFinalization(attempt: ExamAttempt, verifiedKinds?: ExamInteractionKinds): ExamAttempt {
  if (!isAttemptSnapshot(attempt) || (attempt.status !== 'SUBMITTED' && attempt.status !== 'SCORED')
    || !isTimestamp(attempt.submittedAt) || !isTimestamp(attempt.updatedAt) || attempt.updatedAt < attempt.submittedAt) return attempt
  const reason = attempt.finalizationReason ?? 'MANUAL_SUBMISSION'
  const questionIds = attempt.batch.sections.flatMap((section) => section.questionIds)
  // An explicit pinned manifest can enrich a legacy terminal once without
  // inventing a missing answer or reinterpreting an already-scored legacy result.
  let kinds = attempt.interactionKinds
  if (verifiedKinds !== undefined) {
    if (!validInteractionKinds(verifiedKinds, questionIds)
      || (kinds && !samePlain(kinds, verifiedKinds))
      || !Object.entries(attempt.answers).every(([key, answer]) => answer?.kind === verifiedKinds[key])) return attempt
    if (attempt.status === 'SUBMITTED' && !kinds) kinds = Object.freeze({ ...verifiedKinds })
  }
  const enriched = kinds ? { ...attempt, interactionKinds: kinds } : attempt
  const snapshot = finalizedAnswers(enriched, attempt.submittedAt, reason)
  const result = attempt.result && 'schemaVersion' in attempt.result
    ? copyScoredResult(attempt.result as ScoredExamResult) : attempt.result && Object.freeze({ ...attempt.result })
  return Object.freeze({ ...enriched, answers: snapshot.answers, finalizationReason: reason, finalizedAnswerSnapshot: snapshot, result })
}

/** Phase 6-compatible terminal getter, but callers must use the pinned gate to score. */
export function getFinalizedAnswerSnapshot(attempt: ExamAttempt): FinalizedAnswerSnapshot | PinnedFinalizedAnswerSnapshot | null {
  if (!isAttemptSnapshot(attempt) || (attempt.status !== 'SUBMITTED' && attempt.status !== 'SCORED')
    || !attempt.finalizationReason || !isTimestamp(attempt.submittedAt)) return null
  return finalizedAnswers(attempt, attempt.submittedAt, attempt.finalizationReason)
}

/** No active or incomplete/unknown-kind snapshot reaches the scorer. The
 * optional verified map belongs to an already-pinned matching source plan. */
export function getPinnedFinalizedAnswerSnapshot(attempt: ExamAttempt, verifiedKinds?: ExamInteractionKinds): PinnedFinalizedAnswerSnapshot | null {
  if (verifiedKinds !== undefined && attempt.interactionKinds !== undefined && !samePlain(verifiedKinds, attempt.interactionKinds)) return null
  const restored = verifiedKinds === undefined ? attempt : restoreAttemptFinalization(attempt, verifiedKinds)
  const snapshot = getFinalizedAnswerSnapshot(restored)
  return snapshot && 'schemaVersion' in snapshot ? snapshot : null
}
