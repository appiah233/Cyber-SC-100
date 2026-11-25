import { describe, expect, it } from 'vitest'
import { createAttempt, getPinnedFinalizedAnswerSnapshot, transitionAttempt } from '../src/domain/attempt'
import type { AttemptEvent } from '../src/domain/attempt'
import type { CandidateAnswer, ExamAttempt, ExamBatch, ExamSection, PinnedFinalizedAnswerSnapshot } from '../src/domain/model'
import {
  formatScorePercentage, scoreExamAttempt, scoreFinalizedSnapshot, scorePercentage,
} from '../src/domain/scoring'
import type { ScoringBank, ScoringPolicy, ScoringResult } from '../src/domain/scoring'

const version = 'synthetic-scoring-baseline-v1'
const policy: ScoringPolicy = { scoringVersion: 'synthetic-exact-v1', passingPercentage: 75, postExamReviewPolicy: 'NONE' }
const one = (optionId: string): CandidateAnswer => ({ kind: 'SINGLE_CHOICE', optionId })
const set = (...optionIds: string[]): CandidateAnswer => ({ kind: 'MULTIPLE_CHOICE', optionIds })
const order = (...optionIds: string[]): CandidateAnswer => ({ kind: 'ORDERING', optionIds })
const diagram = (response: Extract<CandidateAnswer, { kind: 'SINGLE_CHOICE' }>): CandidateAnswer => ({ kind: 'DIAGRAM_DEPENDENT', response })
const mappingKinds = ['DROPDOWN', 'DROPDOWN_HOTSPOT', 'MATCHING', 'DRAG_DROP', 'STATEMENT'] as const
const mapping = (kind: (typeof mappingKinds)[number], selections: Record<string, string>): CandidateAnswer => ({ kind, selections })
const id = (index: number) => 'facsimile-' + index
function valid(output: ScoringResult) {
  if (!output.ok) throw new Error('Unexpected refusal: ' + output.reason)
  return output.result
}
function step(attempt: ExamAttempt, event: AttemptEvent) {
  const next = transitionAttempt(attempt, event)
  if (!next.ok) throw new Error('Unexpected event refusal: ' + next.reason)
  return next.attempt
}
function make(definitions: readonly CandidateAnswer[], sections?: readonly ExamSection[], batchMode?: ExamBatch['batchMode']): {
  attempt: ExamAttempt
  bank: ScoringBank
} {
  const pairs = definitions.map((answer, i) => [id(i), answer] as const)
  return {
    bank: { bankVersion: version, definitions: Object.fromEntries(pairs) },
    attempt: createAttempt({
      id: 'synthetic-scoring-attempt', cycleId: 'synthetic-scoring-cycle', at: 1,
      batch: {
        id: 'synthetic-scoring-batch', contentVersion: version, seed: 'fixed-synthetic',
        batchMode: batchMode ?? (pairs.length === 59 ? 'ADAPTIVE' : 'FINAL_REMAINDER'),
        sections: sections ?? [{ kind: 'STANDARD_BLOCK', questionIds: pairs.map(([idValue]) => idValue) }],
      },
      interactionKinds: Object.fromEntries(pairs.map(([questionId, value]) => [questionId, value.kind])),
      optionOrder: Object.fromEntries(pairs.map(([questionId]) => [questionId, ['gamma', 'beta', 'alpha']])),
    }),
  }
}
function start(attempt: ExamAttempt) {
  return step(step(attempt, { type: 'PREPARE', at: 2 }), { type: 'START_SECTION', durationMinutes: 1, at: 3 })
}
function final(definitions: readonly CandidateAnswer[], supplied: readonly (CandidateAnswer | undefined)[],
  config: { timeout?: boolean; sections?: readonly ExamSection[]; batchMode?: ExamBatch['batchMode'] } = {},
) {
  const { attempt, bank } = make(definitions, config.sections, config.batchMode)
  let current = start(attempt)
  let timestamp = 4
  for (const [i, section] of current.batch.sections.entries()) {
    for (const questionId of section.questionIds) {
      const index = Number(questionId.slice('facsimile-'.length))
      const answer = supplied[index]
      if (answer) current = step(current, { type: 'SAVE_ANSWER', questionId, answer, at: timestamp++ })
    }
    if (i + 1 < current.batch.sections.length) {
      current = step(current, { type: 'SUBMIT_SECTION', section: current.activeSection!, at: timestamp++ })
      current = step(current, { type: 'START_SECTION', at: timestamp++ })
    }
  }
  const submitted = config.timeout
    ? step(current, { type: 'TIME_EXPIRED', at: 60003 })
    : step(current, { type: 'END_EXAM', at: timestamp })
  const snapshot = getPinnedFinalizedAnswerSnapshot(submitted)
  if (!snapshot) throw new Error('Terminal fixture has no pinned snapshot.')
  return { submitted, snapshot, bank, current }
}

type Vector = {
  readonly name: string
  readonly definition: CandidateAnswer
  readonly good: CandidateAnswer
  readonly wrong: CandidateAnswer
  readonly incomplete?: CandidateAnswer
  readonly extra?: CandidateAnswer
}
const singleAuthority = { kind: 'SINGLE_CHOICE', optionId: 'alpha' } as const
const vectorSet: readonly Vector[] = [
  { name: 'single choice', definition: singleAuthority, good: one('alpha'), wrong: one('beta') },
  { name: 'multiple choice', definition: set('alpha', 'beta'), good: set('beta', 'alpha'), wrong: set('alpha', 'gamma'),
    incomplete: set('alpha'), extra: set('alpha', 'beta', 'gamma') },
  { name: 'ordering', definition: order('alpha', 'gamma', 'beta'), good: order('alpha', 'gamma', 'beta'), wrong: order('alpha', 'beta', 'gamma'),
    incomplete: order('alpha', 'gamma'), extra: order('alpha', 'gamma', 'beta', 'extra') },
  ...mappingKinds.map((kind): Vector => ({
    name: kind, definition: mapping(kind, { first: 'alpha', second: 'beta' }), good: mapping(kind, { second: 'beta', first: 'alpha' }),
    wrong: mapping(kind, { first: 'beta', second: 'alpha' }), incomplete: mapping(kind, { first: 'alpha' }),
    extra: mapping(kind, { first: 'alpha', second: 'beta', third: 'gamma' }),
  })),
  { name: 'diagram wrapper', definition: diagram(singleAuthority), good: diagram(singleAuthority),
    wrong: diagram({ kind: 'SINGLE_CHOICE', optionId: 'beta' }) },
]

describe('typed exact scoring registry', () => {
  it.each(vectorSet)('scores $name by immutable IDs in fixed and reordered displays', ({ definition, good, wrong, incomplete, extra }) => {
    const goodRun = final([definition], [good])
    const restored = JSON.parse(JSON.stringify(goodRun.snapshot)) as PinnedFinalizedAnswerSnapshot
    const replayed = valid(scoreFinalizedSnapshot(restored, goodRun.bank, policy))
    expect(replayed).toStrictEqual(valid(scoreExamAttempt(goodRun.submitted, goodRun.bank, policy)))
    expect(replayed).toMatchObject({ rawScore: 1, maximumScore: 1, correctCount: 1, incorrectCount: 0, unansweredCount: 0, outcome: 'PASS' })
    const absent = final([definition], [])
    expect(valid(scoreFinalizedSnapshot(absent.snapshot, absent.bank, policy)))
      .toMatchObject({ rawScore: 0, incorrectCount: 0, unansweredCount: 1, outcome: 'FAIL' })
    for (const vector of [wrong, incomplete, extra]) {
      if (!vector) continue
      const noCredit = final([definition], [vector])
      expect(valid(scoreFinalizedSnapshot(noCredit.snapshot, noCredit.bank, policy)))
        .toMatchObject({ rawScore: 0, correctCount: 0, incorrectCount: 1, unansweredCount: 0, outcome: 'FAIL' })
    }
    // A malformed persisted envelope is rejected instead of receiving invented credit.
    const invalid = { ...restored, answers: { [id(0)]: { ...good, untrusted: true } } }
    expect(scoreFinalizedSnapshot(invalid, goodRun.bank, policy)).toEqual({ ok: false, reason: 'INVALID_FINALIZED_SNAPSHOT' })
  })

  it('rejects missing or malformed authority even when candidate leaves the question blank', () => {
    const { snapshot } = final([one('alpha')], [])
    expect(scoreFinalizedSnapshot(snapshot, { bankVersion: version, definitions: {} }, policy))
      .toEqual({ ok: false, reason: 'MISSING_ANSWER_DEFINITION' })
    for (const malformed of [
      one('  '), { ...one('alpha'), extra: 1 }, set('alpha'),
    ]) {
      expect(scoreFinalizedSnapshot(snapshot, { bankVersion: version, definitions: { [id(0)]: malformed } }, policy))
        .toEqual({ ok: false, reason: 'INVALID_ANSWER_DEFINITION' })
    }
    const duplicateSet = final([set('alpha', 'beta')], [])
    expect(scoreFinalizedSnapshot(duplicateSet.snapshot, { bankVersion: version, definitions: { [id(0)]: set('alpha', 'alpha') } }, policy))
      .toEqual({ ok: false, reason: 'INVALID_ANSWER_DEFINITION' })
  })

  it('refuses unsupported region scoring without making up any image geometry', () => {
    const pending = make([one('alpha')])
    const image = createAttempt({
      id: pending.attempt.id, cycleId: pending.attempt.cycleId, batch: pending.attempt.batch,
      interactionKinds: { [id(0)]: 'IMAGE_HOTSPOT' }, at: 1,
    })
    const terminal = step(start(image), { type: 'END_EXAM', at: 4 })
    expect(scoreExamAttempt(terminal, { ...pending.bank, definitions: {} }, policy))
      .toEqual({ ok: false, reason: 'UNSUPPORTED_INTERACTION' })
  })
})

describe('terminal-only aggregate scoring', () => {
  it('will not consult the authority for created, ready, active or final-pending states', () => {
    const { attempt } = make([one('alpha')])
    const ready = step(attempt, { type: 'PREPARE', at: 2 })
    const active = step(ready, { type: 'START_SECTION', at: 3 })
    const submitted = step(active, { type: 'SUBMIT_SECTION', section: 'STANDARD_BLOCK', at: 4 })
    const pending = step(submitted, { type: 'OPEN_FINAL_REVIEW', at: 5 })
    const bank = { bankVersion: version, get definitions(): ScoringBank['definitions'] { throw new Error('Active path accessed authority') } }
    for (const invalid of [attempt, ready, active, submitted, pending]) {
      expect(scoreExamAttempt(invalid, bank, policy)).toEqual({ ok: false, reason: 'NO_FINALIZED_ATTEMPT' })
    }
  })

  it.each([
    { mode: 'NORMAL', size: 59 }, { mode: 'ADAPTIVE', size: 59 },
    { mode: 'FINAL_REMAINDER', size: 41 }, { mode: 'FINAL_REMAINDER', size: 23 }, { mode: 'FINAL_REMAINDER', size: 1 },
  ] as const)('uses real $size-question denominator in $mode', ({ mode, size }) => {
    const parts = mode === 'NORMAL' ? [
      { kind: 'CASE_STUDY_1', caseStudyId: 'fixture-case-a', questionIds: [id(0), id(1), id(2)] },
      { kind: 'CASE_STUDY_2', caseStudyId: 'fixture-case-b', questionIds: [id(3), id(4), id(5)] },
      { kind: 'STANDARD_BLOCK', questionIds: Array.from({ length: 49 }, (_, i) => id(i + 6)) },
      { kind: 'FINAL_INTERACTIVE_BLOCK', questionIds: Array.from({ length: 4 }, (_, i) => id(i + 55)) },
    ] as const : undefined
    const run = final(Array.from({ length: size }, () => one('alpha')), [one('alpha')], { sections: parts, batchMode: mode })
    const result = valid(scoreExamAttempt(run.submitted, run.bank, policy))
    expect(result).toMatchObject({
      rawScore: 1, maximumScore: size, questionCount: size, correctCount: 1, incorrectCount: 0, unansweredCount: size - 1,
      percentage: scorePercentage(1, size), displayPercentage: formatScorePercentage(scorePercentage(1, size)),
    })
    expect(result.sectionBreakdown.reduce((n, section) => n + section.questionCount, 0)).toBe(size)
    expect(result.sectionBreakdown).toHaveLength(parts?.length ?? 1)
  })

  it('counts only existing actual sections and actual interaction kinds; never returns per-item marks', () => {
    const definitions = [
      one('alpha'), set('alpha', 'beta'), mapping('DROPDOWN', { target: 'alpha' }), mapping('DROPDOWN', { target: 'alpha' }), one('alpha'),
    ]
    const run = final(definitions, [one('alpha'), set('alpha'), undefined, definitions[3], one('beta')], {
      timeout: true,
      sections: [
        { kind: 'REMAINDER_CASE_STUDY', caseStudyId: 'fixture-case-first', questionIds: [id(0)] },
        { kind: 'REMAINDER_CASE_STUDY', caseStudyId: 'fixture-case-second', questionIds: [id(1)] },
        { kind: 'STANDARD_BLOCK', questionIds: [id(2), id(3)] },
        { kind: 'FINAL_INTERACTIVE_BLOCK', questionIds: [id(4)] },
      ],
    })
    const result = valid(scoreExamAttempt(run.submitted, run.bank, { ...policy, postExamReviewPolicy: 'ANSWERS_AND_EXPLANATIONS' }))
    expect(result).toMatchObject({ correctCount: 2, incorrectCount: 2, unansweredCount: 1, percentage: 40,
      completedAt: 60003, finalizationReason: 'TIME_EXPIRED' })
    expect(result.sectionBreakdown.map((section) => section.sectionId))
      .toEqual(['REMAINDER_CASE_STUDY:fixture-case-first', 'REMAINDER_CASE_STUDY:fixture-case-second', 'STANDARD_BLOCK', 'FINAL_INTERACTIVE_BLOCK'])
    expect(result.interactionTypeBreakdown).toEqual([
      { interactionKind: 'SINGLE_CHOICE', questionCount: 2, correctCount: 1, incorrectCount: 1, unansweredCount: 0 },
      { interactionKind: 'MULTIPLE_CHOICE', questionCount: 1, correctCount: 0, incorrectCount: 1, unansweredCount: 0 },
      { interactionKind: 'DROPDOWN', questionCount: 2, correctCount: 1, incorrectCount: 0, unansweredCount: 1 },
    ])
    const serialized = JSON.stringify(result)
    for (const prohibited of ['alpha', 'beta', 'facsimile-', 'optionId', 'selections', 'definitions']) expect(serialized).not.toContain(prohibited)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.sectionBreakdown[0])).toBe(true)
    expect(Object.isFrozen(result.interactionTypeBreakdown[0])).toBe(true)
  })

  it('uses exact thresholds centrally, gives zero for a blank exam, and blocks invalid configuration', () => {
    const definitions = Array.from({ length: 4 }, () => one('alpha'))
    const atThreshold = final(definitions, [one('alpha'), one('alpha'), one('alpha')])
    expect(valid(scoreExamAttempt(atThreshold.submitted, atThreshold.bank, policy))).toMatchObject({ outcome: 'PASS', displayPercentage: '75.00%' })
    const below = final(definitions, [one('alpha'), one('alpha')])
    expect(valid(scoreExamAttempt(below.submitted, below.bank, policy))).toMatchObject({ outcome: 'FAIL', displayPercentage: '50.00%' })
    const blank = final(definitions, [])
    expect(valid(scoreExamAttempt(blank.submitted, blank.bank, policy))).toMatchObject({ percentage: 0, displayPercentage: '0.00%', unansweredCount: 4 })
    for (const passingPercentage of [-1, 101, Infinity, NaN]) {
      expect(scoreExamAttempt(blank.submitted, blank.bank, { ...policy, passingPercentage })).toEqual({ ok: false, reason: 'INVALID_SCORING_POLICY' })
    }
    expect(scoreExamAttempt(blank.submitted, { ...blank.bank, bankVersion: 'stale' }, policy)).toEqual({ ok: false, reason: 'BANK_VERSION_MISMATCH' })
    expect(scoreFinalizedSnapshot({ ...blank.snapshot, questionIds: [] }, blank.bank, policy))
      .toEqual({ ok: false, reason: 'INVALID_FINALIZED_SNAPSHOT' })
    expect(() => scorePercentage(0, 0)).toThrow('Invalid score counts.')
    expect(formatScorePercentage(scorePercentage(21, 31))).toBe('67.74%')
  })

  it('deterministically repeats and reuses a persisted matching version without recalculation', () => {
    const { submitted, bank, snapshot } = final([one('alpha')], [one('alpha')])
    const result = valid(scoreExamAttempt(submitted, bank, policy))
    expect(valid(scoreFinalizedSnapshot(structuredClone(snapshot), bank, policy))).toStrictEqual(result)
    const persisted = step(submitted, { type: 'RECORD_RESULT', result, at: result.completedAt })
    const reopened = structuredClone(persisted)
    const noRecalculation = { bankVersion: version, get definitions(): ScoringBank['definitions'] { throw new Error('Unexpected recalculation') } }
    expect(valid(scoreExamAttempt(reopened, noRecalculation, policy))).toBe(reopened.result)
    expect(scoreExamAttempt(reopened, noRecalculation, { ...policy, scoringVersion: 'next-version' }))
      .toEqual({ ok: false, reason: 'EXISTING_RESULT_MISMATCH' })
  })
})
