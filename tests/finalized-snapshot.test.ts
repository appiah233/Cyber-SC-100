import { describe, expect, it } from 'vitest'
import {
  createAttempt, getFinalizedAnswerSnapshot, getPinnedFinalizedAnswerSnapshot, isAttemptSnapshot,
  isPinnedFinalizedAnswerSnapshot, isScoredExamResult, restoreAttemptFinalization, transitionAttempt,
} from '../src/domain'
import type { AttemptEvent, ExamAttempt, ExamBatch, ExamInteractionKinds, PinnedFinalizedAnswerSnapshot, ScoredExamResult } from '../src/domain'

const batch: ExamBatch = {
  id: 'fixture-score-batch', contentVersion: 'fixture-score-source-v7', seed: 'fixture-seed', batchMode: 'FINAL_REMAINDER',
  sections: [
    { kind: 'STANDARD_BLOCK', questionIds: ['fixture-single'] },
    { kind: 'FINAL_INTERACTIVE_BLOCK', questionIds: ['fixture-dropdown'] },
  ],
}
const kinds: ExamInteractionKinds = { 'fixture-single': 'SINGLE_CHOICE', 'fixture-dropdown': 'DROPDOWN_HOTSPOT' }
const answer = { kind: 'SINGLE_CHOICE', optionId: 'fixture-selected' } as const
const make = (interactionKinds?: ExamInteractionKinds) => createAttempt({
  id: 'fixture-attempt', cycleId: 'fixture-cycle', batch, interactionKinds, at: 10,
})
function run(attempt: ExamAttempt, event: AttemptEvent): ExamAttempt {
  const changed = transitionAttempt(attempt, event)
  if (!changed.ok) throw new Error(changed.reason)
  return changed.attempt
}
const start = (attempt: ExamAttempt) => run(run(attempt, { type: 'PREPARE', at: 11 }), { type: 'START_SECTION', at: 12 })
function submitted(interactionKinds?: ExamInteractionKinds) {
  return run(run(start(make(interactionKinds)), { type: 'SAVE_ANSWER', at: 13, questionId: 'fixture-single', answer }),
    { type: 'END_EXAM', at: 20 })
}
function sameResult(snapshot: PinnedFinalizedAnswerSnapshot): ScoredExamResult {
  const answered = { correctCount: 1, incorrectCount: 0, unansweredCount: 0, questionCount: 1 }
  const blank = { correctCount: 0, incorrectCount: 0, unansweredCount: 1, questionCount: 1 }
  return {
    schemaVersion: 2, attemptId: snapshot.attemptId, batchId: snapshot.batchId,
    snapshotId: snapshot.snapshotId, bankVersion: snapshot.bankVersion,
    scoringVersion: 'fixture-scoring-v1', scoringPolicyVersion: 'fixture-scoring-v1',
    rawScore: 1, maximumScore: 2, percentage: 50, displayPercentage: '50.00%',
    passingPercentage: 50, outcome: 'PASS', correctCount: 1, incorrectCount: 0, unansweredCount: 1, questionCount: 2,
    completedAt: snapshot.finalizedAt, finalizationReason: snapshot.finalizationReason, postExamReviewPolicy: 'NONE',
    sectionBreakdown: [
      { sectionId: 'STANDARD_BLOCK', sectionKind: 'STANDARD_BLOCK', ...answered },
      { sectionId: 'FINAL_INTERACTIVE_BLOCK', sectionKind: 'FINAL_INTERACTIVE_BLOCK', ...blank },
    ],
    interactionTypeBreakdown: [
      { interactionKind: 'SINGLE_CHOICE', ...answered },
      { interactionKind: 'DROPDOWN_HOTSPOT', ...blank },
    ],
  }
}

describe('pinned finalized candidate snapshot', () => {
  it('pins exact membership and types even for questions the candidate never reaches', () => {
    const mutableInput = { ...kinds }
    const active = start(make(mutableInput))
    mutableInput['fixture-dropdown'] = 'MATCHING'
    expect(getPinnedFinalizedAnswerSnapshot(active)).toBeNull()
    expect(transitionAttempt(active, { type: 'SAVE_ANSWER', at: 13, questionId: 'fixture-single',
      answer: { kind: 'MULTIPLE_CHOICE', optionIds: ['fixture-selected'] } })).toMatchObject({
      ok: false, reason: 'INVALID_ANSWER',
    })
    const terminal = run(active, { type: 'END_EXAM', at: 20 })
    const snapshot = getPinnedFinalizedAnswerSnapshot(terminal)!
    expect(snapshot).toMatchObject({
      schemaVersion: 2, bankVersion: batch.contentVersion, finalizedAt: 20,
      finalizationReason: 'MANUAL_SUBMISSION', sections: batch.sections,
      interactionKinds: kinds, answers: {},
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.sections[0]?.questionIds)).toBe(true)
    expect(Object.isFrozen(snapshot.interactionKinds)).toBe(true)
    expect(getPinnedFinalizedAnswerSnapshot(terminal, mutableInput)).toBeNull()
    expect(transitionAttempt(terminal, { type: 'END_EXAM', at: 25 })).toEqual({ ok: true, attempt: terminal })
  })

  it('validates identity across reload and cannot accept changed section or response under the same ID', () => {
    const terminal = submitted(kinds)
    const clone = structuredClone(terminal)
    expect(isAttemptSnapshot(clone)).toBe(true)
    const snapshot = getPinnedFinalizedAnswerSnapshot(clone)!
    expect(snapshot.snapshotId).toBe(getPinnedFinalizedAnswerSnapshot(terminal)?.snapshotId)
    expect(isPinnedFinalizedAnswerSnapshot({ ...snapshot, bankVersion: 'different' })).toBe(false)
    expect(isPinnedFinalizedAnswerSnapshot({ ...snapshot,
      interactionKinds: { ...snapshot.interactionKinds, 'fixture-dropdown': 'IMAGE_HOTSPOT' } })).toBe(false)
    expect(isPinnedFinalizedAnswerSnapshot({ ...snapshot,
      answers: { 'fixture-single': { ...answer, optionId: 'different' } } })).toBe(false)
    expect(isPinnedFinalizedAnswerSnapshot({ ...snapshot, sections: [...snapshot.sections].reverse() })).toBe(false)
    expect(isPinnedFinalizedAnswerSnapshot({ ...snapshot, explanation: 'not a candidate snapshot field' })).toBe(false)
  })

  it('reads Phase 6 terminal history without inferring unanswered kinds, then migrates only with exact pinned coverage', () => {
    const legacy = submitted()
    expect(isAttemptSnapshot(structuredClone(legacy))).toBe(true)
    expect(getFinalizedAnswerSnapshot(legacy)?.answers).toEqual({ 'fixture-single': answer })
    expect(getPinnedFinalizedAnswerSnapshot(legacy)).toBeNull()
    expect(getPinnedFinalizedAnswerSnapshot(legacy, { 'fixture-single': 'SINGLE_CHOICE' })).toBeNull()
    expect(getPinnedFinalizedAnswerSnapshot(legacy, { ...kinds, 'fixture-single': 'MULTIPLE_CHOICE' })).toBeNull()
    const migrated = restoreAttemptFinalization(structuredClone(legacy), kinds)
    expect(isAttemptSnapshot(migrated)).toBe(true)
    expect(getPinnedFinalizedAnswerSnapshot(migrated)?.snapshotId).toBe(getPinnedFinalizedAnswerSnapshot(submitted(kinds))?.snapshotId)
    expect(migrated).toMatchObject({
      revision: legacy.revision, locks: legacy.locks, expiresAt: legacy.expiresAt, answers: { 'fixture-single': answer },
    })
  })
})

describe('aggregate result transition', () => {
  it('records the strict snapshot-keyed result at most once and does not expose any per-question key', () => {
    const terminal = submitted(kinds)
    const snapshot = getPinnedFinalizedAnswerSnapshot(terminal)!
    const result = sameResult(snapshot)
    expect(isScoredExamResult(result, snapshot)).toBe(true)
    expect(transitionAttempt(start(make(kinds)), { type: 'RECORD_RESULT', at: 20, result })).toMatchObject({
      ok: false, reason: 'INVALID_TRANSITION',
    })
    const scored = run(terminal, { type: 'RECORD_RESULT', at: 21, result })
    expect(scored).toMatchObject({ status: 'SCORED', result })
    expect(run(scored, { type: 'RECORD_RESULT', at: 22, result })).toBe(scored)
    const restored = restoreAttemptFinalization(structuredClone(scored), kinds)
    expect(isAttemptSnapshot(restored)).toBe(true)
    expect(Object.isFrozen(restored.result)).toBe(true)
    expect(Object.isFrozen((restored.result as ScoredExamResult).sectionBreakdown[0])).toBe(true)
    expect(restored.result).not.toHaveProperty('answers')
    expect(restored.result).not.toHaveProperty('correctAnswers')
  })

  it('rejects wrong identities, misaccounting, guessed sections and extra review fields', () => {
    const terminal = submitted(kinds)
    const snapshot = getPinnedFinalizedAnswerSnapshot(terminal)!
    const result = sameResult(snapshot)
    const rejected = [
      { ...result, snapshotId: 'other' },
      { ...result, scoringPolicyVersion: 'other' },
      { ...result, bankVersion: 'other' },
      { ...result, completedAt: 120 },
      { ...result, passingPercentage: 51, outcome: 'PASS' },
      { ...result, maximumScore: 59 },
      { ...result, displayPercentage: '50%' },
      { ...result, sectionBreakdown: [...result.sectionBreakdown].reverse() },
      { ...result, interactionTypeBreakdown: [result.interactionTypeBreakdown[0], result.interactionTypeBreakdown[0]] },
      { ...result, sectionBreakdown: [{ ...result.sectionBreakdown[0], unansweredCount: 1, correctCount: 0 }, result.sectionBreakdown[1]] },
      { ...result, authoritativeAnswerMap: {} },
    ]
    for (const proposed of rejected) expect(isScoredExamResult(proposed, snapshot)).toBe(false)
    expect(transitionAttempt(terminal, { type: 'RECORD_RESULT', result: { correctCount: 1, questionCount: 2, percentage: 50 } }))
      .toMatchObject({ ok: false, reason: 'INVALID_RESULT' })
  })
})
