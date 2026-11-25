import { describe, expect, it } from 'vitest'
import { generateBatch, prepareBatchInventory } from '../src/domain/batch-engine'
import type { BatchBank, BatchQuestion } from '../src/domain/batch-engine'
import { analyzeCycleCapacity } from '../src/domain/cycle-capacity'
import { generateCycleBatch } from '../src/domain/cycle-plan'
import { createCycleLifecycle, transitionCycleLifecycle } from '../src/domain/cycle-lifecycle'
import { createAttempt, getPinnedFinalizedAnswerSnapshot, transitionAttempt } from '../src/domain/attempt'
import type { ExamAttempt } from '../src/domain/model'
import { scoreFinalizedSnapshot } from '../src/domain/scoring'
import releasePolicy from '../src/domain/sc100-release-policy.json'
import { initialCandidate } from '../src/integration/candidate-attempt'
import { createCandidateJourney } from '../src/integration/candidate-journey'

const common = {
  developmentValidated: true, productionEligible: false, standardEligible: true, interactionKind: 'SINGLE_CHOICE',
} as const
const approved = (ordinary: number, deferred: number): BatchBank => ({
  version: 'synthetic-terminal-bank', caseStudies: deferred >= 3
    ? [{ id: 'reviewed-case', childIds: ['pinned-2'], developmentValidated: true, productionEligible: false }] : [],
  questions: [
    ...Array.from({ length: ordinary }, (_, index) => ({ ...common, sourceId: 'ordinary-' + index })),
    ...Array.from({ length: deferred }, (_, index): BatchQuestion => ({
      ...common, sourceId: 'pinned-' + index, finalOnly: true,
      ...(index === 1 ? { interactionKind: 'DROPDOWN_HOTSPOT', interactiveEligible: true } : {}),
    })),
  ],
})
const inputOf = (bank: BatchBank, consumedSourceIds: readonly string[] = []) => ({
  bank, eligibilityPolicy: 'DEVELOPMENT' as const, seed: 'fixed-terminal-seed',
  cycleState: { cycleId: 'terminal-cycle', bankVersion: bank.version, consumedSourceIds, reservedSourceIds: [] },
})

describe('all-remaining terminal planning', () => {
  it('keeps the ordinary batch capped and consumes all 62 remaining questions together with no short tail', () => {
    const bank = approved(116, 5)
    const input = inputOf(bank)
    const first = generateCycleBatch(input)
    if (!first.ok) throw new Error(first.reason)
    expect(first.batch).toMatchObject({ batchMode: 'ADAPTIVE', actualQuestionCount: 59 })
    expect(first.batch.sourceIds.every(id => id.startsWith('ordinary-'))).toBe(true)
    const second = generateCycleBatch(inputOf(bank, first.batch.sourceIds))
    if (!second.ok || second.batch.kind !== 'FINAL_REMAINDER_BATCH') throw new Error('Missing terminal residual')
    expect(second.batch).toMatchObject({ actualQuestionCount: 62, caseStudyQuestionCount: 1, interactiveQuestionCount: 1 })
    expect(second.batch.sections).toContainEqual({ kind: 'REMAINDER_CASE_STUDY', caseStudyId: 'reviewed-case', questionIds: ['pinned-2'] })
    expect(second.batch.interactionKinds['pinned-1']).toBe('DROPDOWN_HOTSPOT')
    expect(second.batch.finalOnlySourceIds?.toSorted()).toEqual(['pinned-0', 'pinned-1', 'pinned-2', 'pinned-3', 'pinned-4'])
    const all = [...first.batch.sourceIds, ...second.batch.sourceIds]
    expect(all.length).toBe(bank.questions.length)
    expect(new Set(all)).toEqual(new Set(bank.questions.map(({ sourceId }) => sourceId)))
    expect(prepareBatchInventory(inputOf(bank, all))).toMatchObject({ ok: false, reason: 'CYCLE_EXHAUSTED' })
    expect(analyzeCycleCapacity(input)).toMatchObject({ ok: true, adaptiveFullBatches: 1, finalRemainderSize: 62, totalEligibleQuestions: 121 })

    const cycle = createCycleLifecycle({ id: 'terminal-credit', cycleId: 'terminal-cycle', bankVersion: bank.version,
      eligibilityPolicy: 'DEVELOPMENT', createdAt: 1 })
    const invalid = { ...second.batch }
    delete (invalid as { finalOnlySourceIds?: readonly string[] }).finalOnlySourceIds
    expect(transitionCycleLifecycle(cycle, { type: 'GENERATE', batch: invalid, at: 2 })).toMatchObject({ ok: false, reason: 'INVALID_BATCH' })
    expect(transitionCycleLifecycle(cycle, { type: 'GENERATE', batch: second.batch, at: 2 }).ok).toBe(true)
  })

  it('fails closed on a structurally valid substituted terminal subset or forged terminal designation after reload', () => {
    const canonical = approved(57, 5)
    const configure = (bank: BatchBank) => createCandidateJourney({
      id: 'wide-recovery', idbName: 'wide-recovery-db', bank, eligibilityPolicy: 'DEVELOPMENT',
      sourceFor: () => ({
        question: id => ({ id, prompt: 'Synthetic terminal item', interaction: { kind: 'SINGLE_CHOICE', options: [] } }),
      }),
    })
    const trueJourney = configure(canonical)
    const restored = (bank: BatchBank) => {
      const generator = configure(bank)
      const draft = initialCandidate({ ...generator.initial(), journey: { id: 'wide-recovery', advance: generator.advance,
        onAdvanced() {}, onStale() {} } }, 1)
      return { ...draft, cycleRevision: 0, contentVersion: bank.version, lease: null }
    }
    expect(trueJourney.sourceForRecord(restored(canonical)).batch.total).toBe(62)
    const subset = { ...canonical, questions: canonical.questions.filter(q => q.sourceId !== 'ordinary-0') }
    expect(restored(subset).attempt.batch.sections.flatMap(section => section.questionIds)).toHaveLength(61)
    expect(() => trueJourney.sourceForRecord(restored(subset))).toThrow('could not be validated')
    const wrongMarker: BatchBank = { ...canonical, questions: canonical.questions.map(q => {
      if (q.sourceId === 'pinned-0') {
        const { finalOnly: previous, ...extra } = q
        void previous
        return extra
      }
      return q.sourceId === 'ordinary-0' ? { ...q, finalOnly: true } : q
    }) }
    expect(restored(wrongMarker).attempt.batch.sections.flatMap(section => section.questionIds)).toHaveLength(62)
    expect(() => trueJourney.sourceForRecord(restored(wrongMarker))).toThrow('could not be validated')
  })

  it('joins the last exactly full ordinary block with a deferred item, without imposing an arbitrary 62 threshold', () => {
    expect(generateBatch(inputOf(approved(59, 1)))).toMatchObject({
      ok: true, batch: { batchMode: 'FINAL_REMAINDER', actualQuestionCount: 60 },
    })
    expect(generateBatch(inputOf(approved(57, 12)))).toMatchObject({
      ok: true, batch: { batchMode: 'FINAL_REMAINDER', actualQuestionCount: 69 },
    })
    expect(generateBatch(inputOf(approved(62, 0)))).toMatchObject({
      ok: true, batch: { batchMode: 'ADAPTIVE', actualQuestionCount: 59 },
    })
    expect(generateBatch(inputOf(approved(1, 0)))).toMatchObject({
      ok: true, batch: { batchMode: 'FINAL_REMAINDER', actualQuestionCount: 1 },
    })
  })
})

describe('SC-100 unrounded threshold and wide terminal storage boundary', () => {
  it.each([
    [53, 59, 'FAIL'], [54, 59, 'PASS'], [55, 62, 'FAIL'], [56, 62, 'PASS'],
  ] as const)('%s correct of %s is %s at exactly configured 90%%', (correct, questionCount, outcome) => {
    const bank = approved(questionCount === 62 ? 57 : 59, questionCount === 62 ? 5 : 0)
    const { questions } = bank
    // For this threshold vector, score just an actual standard response pool.
    const ids = questions.map(({ sourceId }) => sourceId)
    const kinds = Object.fromEntries(ids.map(id => [id, 'SINGLE_CHOICE' as const]))
    const draft = createAttempt({
      id: 'score-vector-' + correct, cycleId: 'terminal-cycle', interactionKinds: kinds,
      batch: { id: 'batch-vector-' + correct, contentVersion: bank.version, seed: 1,
        batchMode: questionCount === 62 ? 'FINAL_REMAINDER' : 'ADAPTIVE',
        sections: [{ kind: 'STANDARD_BLOCK', questionIds: ids }] },
    })
    const step = (attempt: ExamAttempt, event: Parameters<typeof transitionAttempt>[1]) => {
      const result = transitionAttempt(attempt, event)
      if (!result.ok) throw new Error(result.reason)
      return result.attempt
    }
    let current = step(step(draft, { type: 'PREPARE', at: 1 }), { type: 'START_SECTION', at: 2, durationMinutes: 1 })
    ids.forEach((id, index) => {
      current = step(current, { type: 'SAVE_ANSWER', questionId: id,
        answer: { kind: 'SINGLE_CHOICE', optionId: index < correct ? 'yes' : 'no' }, at: index + 3 })
    })
    const locked = step(current, questionCount === 62 ? { type: 'TIME_EXPIRED', at: 60_002 }
      : { type: 'END_EXAM', at: 100 })
    const pinned = getPinnedFinalizedAnswerSnapshot(structuredClone(locked))
    if (!pinned) throw new Error('Missing finalized snapshot')
    const result = scoreFinalizedSnapshot(pinned, { bankVersion: bank.version,
      definitions: Object.fromEntries(ids.map(id => [id, { kind: 'SINGLE_CHOICE' as const, optionId: 'yes' }])) },
    { ...releasePolicy, postExamReviewPolicy: 'NONE' })
    if (!result.ok) throw new Error(result.reason)
    expect(result.result).toMatchObject({ outcome, passingPercentage: 90, rawScore: correct, maximumScore: questionCount })
    expect(result.result.percentage).toBe(correct * 100 / questionCount)
    expect(step(locked, { type: 'RECORD_RESULT', result: result.result, at: 60_002 }).status).toBe('SCORED')
  })
})
