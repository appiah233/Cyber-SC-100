import { examSectionKey, getPinnedFinalizedAnswerSnapshot, isPinnedFinalizedAnswerSnapshot, isScoredExamResult } from './attempt'
import type { CandidateAnswer, ExamAttempt, PinnedFinalizedAnswerSnapshot, PostExamReviewPolicy, QuestionInteraction, ScoredExamResult } from './model'

/** Separate, version-pinned authoritative data. Never import a filled bank here. */
export interface ScoringBank {
  readonly bankVersion: string
  readonly definitions: Readonly<Record<string, CandidateAnswer>>
}

export interface ScoringPolicy {
  readonly scoringVersion: string
  readonly passingPercentage: number
  readonly postExamReviewPolicy: PostExamReviewPolicy
}

export type ScoringFailure =
  | 'NO_FINALIZED_ATTEMPT'
  | 'INVALID_FINALIZED_SNAPSHOT'
  | 'BANK_VERSION_MISMATCH'
  | 'INVALID_SCORING_BANK'
  | 'INVALID_SCORING_POLICY'
  | 'UNSUPPORTED_INTERACTION'
  | 'MISSING_ANSWER_DEFINITION'
  | 'INVALID_ANSWER_DEFINITION'
  | 'EXISTING_RESULT_MISMATCH'

export type ScoringResult =
  | { readonly ok: true; readonly result: ScoredExamResult }
  | { readonly ok: false; readonly reason: ScoringFailure }

const fail = (reason: ScoringFailure): ScoringResult => ({ ok: false, reason })
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value === value.trim()
const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const exact = (value: Readonly<Record<string, unknown>>, ...keys: readonly string[]): boolean =>
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => {
    const own = Object.getOwnPropertyDescriptor(value, key)
    return own?.enumerable === true && 'value' in own
  })
const ownAnswer = (value: unknown, kind: unknown, prop: string): unknown =>
  record(value) && exact(value, 'kind', prop) && value.kind === kind ? value[prop] : undefined

function list(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || Reflect.ownKeys(value).length !== value.length + 1) return undefined
  const ids = Array.from(value)
  return ids.every(id) && new Set(ids).size === ids.length ? ids : undefined
}

function keyedChoices(value: unknown): ReadonlyMap<string, string> | undefined {
  if (!record(value)) return undefined
  const keys = Reflect.ownKeys(value)
  if (!keys.length) return undefined
  const choices = new Map<string, string>()
  for (const key of keys) {
    if (!id(key)) return undefined
    const prop = Object.getOwnPropertyDescriptor(value, key)
    if (!prop?.enumerable || !('value' in prop) || !id(prop.value)) return undefined
    choices.set(key, prop.value)
  }
  return choices
}

type Grade = 'CORRECT' | 'INCORRECT' | 'INVALID_DEFINITION' | 'UNSUPPORTED'
type Scorer = (authority: unknown, response: unknown) => Grade
type SupportedKind = Exclude<QuestionInteraction['kind'], 'IMAGE_HOTSPOT'>
type DirectKind = Exclude<SupportedKind, 'DIAGRAM_DEPENDENT'>
type MappingKind = Extract<DirectKind, 'DROPDOWN' | 'DROPDOWN_HOTSPOT' | 'STATEMENT' | 'MATCHING' | 'DRAG_DROP'>

function exactScorer<T>(read: (value: unknown) => T | undefined, compare: (expected: T, actual: T) => boolean): Scorer {
  return (authority, response) => {
    const expected = read(authority)
    if (expected === undefined) return 'INVALID_DEFINITION'
    const actual = read(response)
    return actual !== undefined && compare(expected, actual) ? 'CORRECT' : 'INCORRECT'
  }
}

const exactMapping = (kind: MappingKind) => exactScorer(
  (value) => keyedChoices(ownAnswer(value, kind, 'selections')),
  (expected, actual) => expected.size === actual.size && [...expected].every(([key, option]) => actual.get(key) === option),
)

const directScorers = {
  SINGLE_CHOICE: exactScorer((value) => {
    const optionId = ownAnswer(value, 'SINGLE_CHOICE', 'optionId')
    return id(optionId) ? optionId : undefined
  }, (expected, actual) => expected === actual),
  MULTIPLE_CHOICE: exactScorer((value) => {
    const optionIds = list(ownAnswer(value, 'MULTIPLE_CHOICE', 'optionIds'))
    return optionIds ? new Set(optionIds) : undefined
  }, (expected, actual) => expected.size === actual.size && [...expected].every((optionId) => actual.has(optionId))),
  DROPDOWN: exactMapping('DROPDOWN'),
  MATCHING: exactMapping('MATCHING'),
  DRAG_DROP: exactMapping('DRAG_DROP'),
  ORDERING: exactScorer(
    (value) => list(ownAnswer(value, 'ORDERING', 'optionIds')),
    (expected, actual) => expected.length === actual.length && expected.every((item, position) => actual[position] === item),
  ),
  STATEMENT: exactMapping('STATEMENT'),
  DROPDOWN_HOTSPOT: exactMapping('DROPDOWN_HOTSPOT'),
} satisfies Readonly<Record<DirectKind, Scorer>>

const isDirectKind = (kind: unknown): kind is DirectKind => typeof kind === 'string' && Object.hasOwn(directScorers, kind)
function diagramScorer(authority: unknown, response: unknown): Grade {
  const expected = ownAnswer(authority, 'DIAGRAM_DEPENDENT', 'response')
  if (!record(expected)) return 'INVALID_DEFINITION'
  if (expected.kind === 'IMAGE_HOTSPOT') return 'UNSUPPORTED'
  if (!isDirectKind(expected.kind)) return 'INVALID_DEFINITION'
  return directScorers[expected.kind](expected, ownAnswer(response, 'DIAGRAM_DEPENDENT', 'response'))
}

// No coordinate scorer: the verified source contains no genuine image regions.
const scorers = {
  ...directScorers,
  DIAGRAM_DEPENDENT: diagramScorer,
} satisfies Readonly<Record<SupportedKind, Scorer>>

const postExamPolicies = new Set<PostExamReviewPolicy>(['NONE', 'RESPONSES_ONLY', 'CORRECTNESS', 'ANSWERS_AND_EXPLANATIONS'])
function validPolicy(policy: ScoringPolicy): boolean {
  return !!policy && id(policy.scoringVersion) && Number.isFinite(policy.passingPercentage) &&
    policy.passingPercentage >= 0 && policy.passingPercentage <= 100 && postExamPolicies.has(policy.postExamReviewPolicy)
}

export function scorePercentage(correctCount: number, questionCount: number): number {
  if (!Number.isSafeInteger(correctCount) || !Number.isSafeInteger(questionCount) ||
    questionCount < 1 || correctCount < 0 || correctCount > questionCount) throw new RangeError('Invalid score counts.')
  return (100 * correctCount) / questionCount
}

export function formatScorePercentage(percentage: number): string {
  return percentage.toFixed(2) + '%'
}

type Counts = { questionCount: number; correctCount: number; incorrectCount: number; unansweredCount: number }
const counts = (): Counts => ({ questionCount: 0, correctCount: 0, incorrectCount: 0, unansweredCount: 0 })
function addCount(total: Counts, grade: 'CORRECT' | 'INCORRECT' | 'UNANSWERED') {
  total.questionCount++
  if (grade === 'CORRECT') total.correctCount++
  else if (grade === 'INCORRECT') total.incorrectCount++
  else total.unansweredCount++
}

/** The only input is a pinned terminal snapshot; no answer key, candidate-level
 * marks, explanations, or per-question comparisons are returned. */
export function scoreFinalizedSnapshot(
  snapshot: PinnedFinalizedAnswerSnapshot,
  bank: ScoringBank,
  policy: ScoringPolicy,
): ScoringResult {
  if (!isPinnedFinalizedAnswerSnapshot(snapshot)) return fail('INVALID_FINALIZED_SNAPSHOT')
  if (!validPolicy(policy)) return fail('INVALID_SCORING_POLICY')
  if (!bank || !id(bank.bankVersion) || !record(bank.definitions)) return fail('INVALID_SCORING_BANK')
  if (bank.bankVersion !== snapshot.bankVersion) return fail('BANK_VERSION_MISMATCH')

  const overall = counts()
  const sectionBreakdown: ScoredExamResult['sectionBreakdown'][number][] = []
  const interactions = new Map<QuestionInteraction['kind'], Counts>()
  for (const section of snapshot.sections) {
    const sectionCounts = counts()
    for (const questionId of section.questionIds) {
      const kind = snapshot.interactionKinds[questionId]
      if (kind === 'IMAGE_HOTSPOT' || !Object.hasOwn(scorers, kind)) return fail('UNSUPPORTED_INTERACTION')
      const definition = Object.getOwnPropertyDescriptor(bank.definitions, questionId)
      if (!definition) return fail('MISSING_ANSWER_DEFINITION')
      if (!definition.enumerable || !('value' in definition)) return fail('INVALID_ANSWER_DEFINITION')
      const recorded = Object.hasOwn(snapshot.answers, questionId)
      const outcome = scorers[kind](definition.value, recorded ? snapshot.answers[questionId] : undefined)
      if (outcome === 'UNSUPPORTED') return fail('UNSUPPORTED_INTERACTION')
      if (outcome === 'INVALID_DEFINITION') return fail('INVALID_ANSWER_DEFINITION')
      const grade = recorded ? outcome : 'UNANSWERED'
      const interactionCounts = interactions.get(kind) ?? counts()
      addCount(interactionCounts, grade)
      interactions.set(kind, interactionCounts)
      addCount(sectionCounts, grade)
      addCount(overall, grade)
    }
    sectionBreakdown.push(Object.freeze({
      sectionId: examSectionKey(section), sectionKind: section.kind,
      ...(section.caseStudyId === undefined ? {} : { caseStudyId: section.caseStudyId }),
      ...sectionCounts,
    }))
  }
  const percentage = scorePercentage(overall.correctCount, overall.questionCount)
  const result: ScoredExamResult = Object.freeze({
    schemaVersion: 2,
    attemptId: snapshot.attemptId,
    batchId: snapshot.batchId,
    snapshotId: snapshot.snapshotId,
    bankVersion: snapshot.bankVersion,
    scoringVersion: policy.scoringVersion,
    scoringPolicyVersion: policy.scoringVersion,
    completedAt: snapshot.finalizedAt,
    finalizationReason: snapshot.finalizationReason,
    postExamReviewPolicy: policy.postExamReviewPolicy,
    passingPercentage: policy.passingPercentage,
    outcome: percentage >= policy.passingPercentage ? 'PASS' : 'FAIL',
    rawScore: overall.correctCount,
    maximumScore: overall.questionCount,
    percentage,
    displayPercentage: formatScorePercentage(percentage),
    ...overall,
    sectionBreakdown: Object.freeze(sectionBreakdown),
    interactionTypeBreakdown: Object.freeze([...interactions].map(([interactionKind, values]) =>
      Object.freeze({ interactionKind, ...values }))),
  })
  return { ok: true, result }
}

/** Never scores active attempt state, and never silently overwrites a stored
 * rich result after a scoring policy/version change. */
export function scoreExamAttempt(
  attempt: ExamAttempt,
  bank: ScoringBank,
  policy: ScoringPolicy,
  verifiedInteractionKinds?: PinnedFinalizedAnswerSnapshot['interactionKinds'],
): ScoringResult {
  const snapshot = getPinnedFinalizedAnswerSnapshot(attempt, verifiedInteractionKinds)
  if (!snapshot) return fail('NO_FINALIZED_ATTEMPT')
  if (attempt.status === 'SCORED' && isScoredExamResult(attempt.result, snapshot)) {
    const result = attempt.result
    if (!validPolicy(policy)) return fail('INVALID_SCORING_POLICY')
    if (!bank || bank.bankVersion !== snapshot.bankVersion) return fail('BANK_VERSION_MISMATCH')
    if (result.scoringVersion !== policy.scoringVersion || result.passingPercentage !== policy.passingPercentage ||
      result.postExamReviewPolicy !== policy.postExamReviewPolicy) return fail('EXISTING_RESULT_MISMATCH')
    return { ok: true, result }
  }
  if (attempt.status === 'SCORED') return fail('EXISTING_RESULT_MISMATCH')
  return scoreFinalizedSnapshot(snapshot, bank, policy)
}
