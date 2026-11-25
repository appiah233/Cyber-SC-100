import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { generateBatch } from '../src/domain/batch-engine'
import type { BatchBank, GeneratedBatch } from '../src/domain/batch-engine'
import { analyzeCycleCapacity } from '../src/domain/cycle-capacity'
import { activeExamCycle } from '../src/domain/cycle-lifecycle'
import { generateCycleBatch } from '../src/domain/cycle-plan'
import { createCycleController } from '../src/integration/cycle-controller'
import { createCycleRepository } from '../src/storage/cycle-repository'
import { adaptivePool, choiceOptionIds, ownerScenarios } from './fixtures/adaptive-pool'
import type { QaCase } from './fixtures/adaptive-pool'

function input(bank: BatchBank, consumedSourceIds: readonly string[], seed: number | string, reservedSourceIds: readonly string[] = []) {
  return {
    bank, seed, eligibilityPolicy: 'DEVELOPMENT' as const,
    cycleState: { cycleId: 'qa-adaptive-cycle', bankVersion: bank.version, consumedSourceIds, reservedSourceIds },
  }
}

function assertBatchContract(bank: BatchBank, batch: GeneratedBatch, expected: QaCase['breakdown'][number]) {
  const [batchMode, caseStudyQuestionCount, standardQuestionCount, interactiveQuestionCount] = expected
  const total = caseStudyQuestionCount + standardQuestionCount + interactiveQuestionCount
  expect(batch).toMatchObject({
    batchMode, targetQuestionCount: 59, actualQuestionCount: total, total, caseStudyQuestionCount,
    standardQuestionCount, interactiveQuestionCount, contentVersion: bank.version, bankVersion: bank.version,
    unsectionedQuestionCount: 0, batchId: batch.id,
  })
  expect(batch.id).not.toBe('')
  expect(batch.cycleId).toBe('qa-adaptive-cycle')
  expect(batch.sourceIds).toHaveLength(total)
  expect(new Set(batch.sourceIds).size).toBe(total)
  expect(batch.sections.flatMap(({ questionIds }) => questionIds)).toEqual(batch.sourceIds)
  expect(batch.sections.every(({ questionIds }) => questionIds.length > 0)).toBe(true)
  expect(batch.sections.filter(({ kind }) => kind === 'STANDARD_BLOCK').flatMap(x => x.questionIds)).toHaveLength(standardQuestionCount)
  expect(batch.sections.filter(({ kind }) => kind === 'FINAL_INTERACTIVE_BLOCK').flatMap(x => x.questionIds)).toHaveLength(interactiveQuestionCount)
  expect(batch.sections.filter(({ caseStudyId }) => caseStudyId !== undefined).flatMap(x => x.questionIds)).toHaveLength(caseStudyQuestionCount)

  const families = new Map(bank.caseStudies.map(({ id, childIds }) => [id, new Set(childIds)]))
  const questions = new Map(bank.questions.map(item => [item.sourceId, item]))
  for (const section of batch.sections) for (const id of section.questionIds) {
    const source = questions.get(id)
    expect(source?.developmentValidated).toBe(true)
    expect(source?.held).not.toBe(true)
    expect(batch.interactionKinds[id]).toBe(source?.interactionKind)
    if (section.caseStudyId) {
      expect(families.get(section.caseStudyId)?.has(id)).toBe(true)
      expect(batch.sourceCaseStudyIds[id]).toBe(section.caseStudyId)
      expect(section.kind).toMatch(/CASE_STUDY/)
    } else if (source?.interactiveEligible) {
      expect(section.kind).toBe('FINAL_INTERACTIVE_BLOCK')
      expect(source.interactionKind).toMatch(/DROPDOWN_HOTSPOT|MATCHING/)
    } else {
      expect(source?.standardEligible).toBe(true)
      expect(section.kind).toBe('STANDARD_BLOCK')
    }
    if (source?.interactionKind === 'SINGLE_CHOICE') {
      expect(batch.optionOrder[id]?.toSorted()).toEqual(choiceOptionIds.toSorted())
    }
  }
}

describe('Owner adaptive exhaustion policy: independent A–H coverage', () => {
  it.each(ownerScenarios)('Case $letter: $description', ({ pool, retired, breakdown }) => {
    const bank = adaptivePool({ ...pool, exclusions: true })
    const eligible = bank.questions.filter(q => q.developmentValidated && !q.held).map(q => q.sourceId).sort()
    const expectedRemaining = eligible.filter(id => !retired.includes(id))
    const capacity = analyzeCycleCapacity(input(bank, retired, 'capacity'))
    expect(capacity).toMatchObject({
      ok: true,
      maximumNormalFullBatches: breakdown.filter(([mode]) => mode === 'NORMAL').length,
      adaptiveFullBatches: breakdown.filter(([mode]) => mode === 'ADAPTIVE').length,
      finalRemainderSize: expectedRemaining.length % 59,
      totalEligibleQuestions: expectedRemaining.length,
    })
    for (let seed = 0; seed < 12; seed += 1) {
      const used = [...retired]
      let generatedQuestionCount = 0
      for (const expected of breakdown) {
        const state = input(bank, used, seed)
        const result = generateCycleBatch(state)
        if (!result.ok) throw new Error('Unexpected exhaustion or validation failure: ' + result.reason)
        const batch = result.batch
        assertBatchContract(bank, batch, expected)
        expect(batch.seed).toBe(seed)
        expect(batch.sourceIds.some(id => used.includes(id))).toBe(false)
        expect(generateCycleBatch(state)).toEqual(result)
        used.push(...batch.sourceIds)
        generatedQuestionCount += batch.actualQuestionCount
      }
      expect(used.toSorted()).toEqual(eligible)
      expect(new Set(used).size).toBe(used.length)
      expect(generatedQuestionCount).toBe(expectedRemaining.length)
      expect(generateCycleBatch(input(bank, used, seed))).toMatchObject({ ok: false, reason: 'CYCLE_EXHAUSTED' })
    }
  })
})

it('makes real one-family and partial-family 59-question batches without minting a second family', () => {
  for (const size of [3, 2]) {
    const bank = adaptivePool({ families: [size], standard: 55 - size, interactive: 4 })
    const result = generateBatch(input(bank, [], 'only-one-family'))
    if (!result.ok) throw new Error(result.reason)
    assertBatchContract(bank, result.batch, ['ADAPTIVE', size, 55 - size, 4])
    expect(result.batch.sections.filter(section => section.caseStudyId !== undefined).map(section => section.caseStudyId)).toEqual(['qa-family-1'])
  }
})

it('does not pad final sizes 42, 17, 6, and 1 or promote a held/unvalidated source', () => {
  for (const size of [42, 17, 6, 1]) {
    const bank = adaptivePool({ standard: size, exclusions: true })
    const result = generateBatch(input(bank, [], 'under-target'))
    if (!result.ok) throw new Error(result.reason)
    assertBatchContract(bank, result.batch, ['FINAL_REMAINDER', 0, size, 0])
  }
})

it('excludes genuinely reserved IDs and preserves production rejection for the synthetic development pool', () => {
  const bank = adaptivePool({ families: [3, 3], standard: 1, interactive: 1 })
  const reserved = [...bank.caseStudies[0]!.childIds, 'qa-interactive-1']
  const result = generateBatch(input(bank, [], 'reserved', reserved))
  if (!result.ok) throw new Error(result.reason)
  assertBatchContract(bank, result.batch, ['FINAL_REMAINDER', 3, 1, 0])
  expect(result.batch.sourceIds.some(id => reserved.includes(id))).toBe(false)
  expect(generateBatch({ ...input(bank, [], 'production'), eligibilityPolicy: 'PRODUCTION' })).toMatchObject({
    ok: false, reason: 'INSUFFICIENT_PRODUCTION_CONTENT',
  })
})

it('transactionally consumes the exact inventory through normal, adaptive and final generation, then explicitly starts a new cycle', async () => {
  const bank = adaptivePool({ families: [3, 3], interactive: 4, standard: 170, exclusions: true })
  const repo = createCycleRepository({ indexedDB: new IDBFactory(), now: () => 1 })
  try {
    const controller = createCycleController(bank, repo)
    let timestamp = 1
    let session = await controller.initialize({
      id: 'qa-transactional-registry', cycleId: 'qa-adaptive-cycle', eligibilityPolicy: 'DEVELOPMENT', createdAt: timestamp,
    }, 'qa-writer')
    const expected = bank.questions.filter(q => q.developmentValidated && !q.held).map(q => q.sourceId).sort()
    const seen: string[] = []
    const counts = [
      ['NORMAL', 6, 49, 4], ['ADAPTIVE', 0, 59, 0], ['ADAPTIVE', 0, 59, 0], ['FINAL_REMAINDER', 0, 3, 0],
    ] as const
    for (const breakdown of counts) {
      expect(await controller.completeIfExhausted(session, ++timestamp)).toMatchObject({ ok: false, reason: 'ELIGIBLE_CONTENT_REMAINS' })
      const draft = await controller.generate(session, 'transactional-seed', ++timestamp)
      if (!draft.ok) throw new Error('Could not durably generate the next adaptive draft')
      assertBatchContract(bank, draft.plan.batch, breakdown)
      const { id, sourceIds } = draft.plan.batch
      expect(activeExamCycle(draft.session.state).status).toBe('ACTIVE')
      const started = await controller.transition(draft.session, { type: 'START', batchId: id, at: ++timestamp })
      if (!started.ok) throw new Error('Could not reserve the draft')
      expect(activeExamCycle(started.state).reservedSourceIds.toSorted()).toEqual(sourceIds.toSorted())
      if (breakdown[0] === 'FINAL_REMAINDER') {
        expect(await controller.completeIfExhausted(started.session, ++timestamp)).toMatchObject({ ok: false, reason: 'ACTIVE_BATCH_EXISTS' })
        const beforeFinal = await controller.load('qa-transactional-registry')
        expect(beforeFinal && activeExamCycle(beforeFinal.state).status).toBe('ACTIVE')
        expect(beforeFinal && activeExamCycle(beforeFinal.state).consumedSourceIds.toSorted()).toEqual(seen.toSorted())
      }
      const completed = await controller.transition(started.session, { type: 'COMPLETE', batchId: id, at: ++timestamp })
      if (!completed.ok) throw new Error('Could not consume the batch')
      session = completed.session
      seen.push(...sourceIds)
      expect(activeExamCycle(session.state).consumedSourceIds.toSorted()).toEqual(seen.toSorted())
      expect(activeExamCycle(session.state).reservedSourceIds).toHaveLength(0)
      expect(activeExamCycle(session.state).status).toBe('ACTIVE')
    }
    expect(seen.toSorted()).toEqual(expected)
    expect(new Set(seen).size).toBe(seen.length)
    expect(await controller.generate(session, 'no-more', ++timestamp)).toMatchObject({ ok: false, plan: { reason: 'CYCLE_EXHAUSTED' } })
    const complete = await controller.completeIfExhausted(session, ++timestamp)
    if (!complete.ok) throw new Error('All eligible items are consumed; the cycle should now close')
    expect(activeExamCycle(complete.state)).toMatchObject({ status: 'COMPLETE', id: 'qa-adaptive-cycle' })
    const reloaded = await controller.load('qa-transactional-registry')
    expect(reloaded?.state).toEqual(complete.state)
    expect(await controller.generate(complete.session, 'no-auto-restart', ++timestamp)).toMatchObject({
      ok: false, plan: { reason: 'CYCLE_COMPLETE' },
    })
    const restarted = await controller.startNewCycle(complete.session, 'qa-explicit-next-cycle', ++timestamp)
    if (!restarted.ok) throw new Error('Explicit next cycle should start')
    expect(activeExamCycle(restarted.state)).toMatchObject({
      id: 'qa-explicit-next-cycle', status: 'ACTIVE', consumedSourceIds: [], reservedSourceIds: [],
    })
    expect(restarted.state.cycles[0]?.consumedSourceIds.toSorted()).toEqual(expected)
  } finally {
    repo.close()
  }
})
