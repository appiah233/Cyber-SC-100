import { describe, expect, it } from 'vitest'
import type { GeneratedBatch, GeneratedNormalBatch, GeneratedRemainderBatch } from '../src/domain/batch-engine'
import {
  activeExamCycle, createCycleLifecycle, cycleCompatibility, isCycleLifecycle, restoreCycleLifecycle,
  transitionCycleLifecycle,
} from '../src/domain/cycle-lifecycle'
import type { CycleLifecycle, CycleLifecycleCommand } from '../src/domain/cycle-lifecycle'
import { NORMAL_SECTIONS } from '../src/domain/model'

function initialize() {
  return createCycleLifecycle({ id: 'registry', cycleId: 'cycle', bankVersion: 'bank-v1',
    eligibilityPolicy: 'DEVELOPMENT', createdAt: 100 })
}

function normal(id: string, namespace: string): GeneratedNormalBatch {
  let index = 0
  const sections = NORMAL_SECTIONS.map(({ kind, count }, position) => ({
    kind,
    questionIds: Array.from({ length: count }, () => `${namespace}-${++index}`),
    ...(position < 2 ? { caseStudyId: `demo-family-${position}` } : {}),
  }))
  const sourceIds = sections.flatMap(({ questionIds }) => questionIds)
  return {
    id, batchId: id, kind: 'NORMAL_BATCH', batchMode: 'NORMAL', cycleId: 'cycle',
    contentVersion: 'bank-v1', bankVersion: 'bank-v1',
    actualQuestionCount: 59, targetQuestionCount: 59, caseStudyQuestionCount: 6,
    standardQuestionCount: 49, interactiveQuestionCount: 4, unsectionedQuestionCount: 0,
    sourceCaseStudyIds: Object.fromEntries(sections.slice(0, 2).flatMap(({ caseStudyId, questionIds }) =>
      questionIds.map(key => [key, caseStudyId!]))),
    seed: 'synthetic-test', eligibilityPolicy: 'DEVELOPMENT', mode: 'DEVELOPMENT',
    sections, sourceIds, total: 59, optionOrder: { [sourceIds[0]]: ['opt-2', 'opt-1'] },
    interactionKinds: Object.fromEntries(sourceIds.map((question, position) => [
      question, position < 55 ? 'SINGLE_CHOICE' : 'DROPDOWN_HOTSPOT',
    ])),
  }
}

function remainder(id: string): GeneratedRemainderBatch {
  return {
    id, batchId: id, kind: 'FINAL_REMAINDER_BATCH', batchMode: 'FINAL_REMAINDER', cycleId: 'cycle',
    contentVersion: 'bank-v1', bankVersion: 'bank-v1',
    actualQuestionCount: 3, targetQuestionCount: 59, caseStudyQuestionCount: 1,
    standardQuestionCount: 0, interactiveQuestionCount: 1, unsectionedQuestionCount: 1,
    sourceCaseStudyIds: { 'r-case': 'remaining-family' },
    seed: 'synthetic-test', eligibilityPolicy: 'DEVELOPMENT', mode: 'DEVELOPMENT',
    sections: [
      { kind: 'REMAINDER_CASE_STUDY', caseStudyId: 'remaining-family', questionIds: ['r-case'] },
      { kind: 'REMAINDER_UNSECTIONED', questionIds: ['r-loose'] },
      { kind: 'FINAL_INTERACTIVE_BLOCK', questionIds: ['r-interactive'] },
    ],
    sourceIds: ['r-case', 'r-loose', 'r-interactive'], total: 3, optionOrder: {},
    interactionKinds: { 'r-case': 'SINGLE_CHOICE', 'r-loose': 'SINGLE_CHOICE', 'r-interactive': 'MATCHING' },
    normalFailure: 'INTERACTIVE_POOL_EXHAUSTED',
  }
}

function step(state: CycleLifecycle, command: CycleLifecycleCommand): CycleLifecycle {
  const result = transitionCycleLifecycle(state, command)
  if (!result.ok) throw new Error(`Expected success, got ${result.reason}`)
  expect(isCycleLifecycle(result.state)).toBe(true)
  expect(result.state.revision).toBe(state.revision + 1)
  return result.state
}

function generate(state: CycleLifecycle, batch: GeneratedBatch, at: number) {
  return step(state, { type: 'GENERATE', batch, at })
}

describe('cycle and batch lifecycle', () => {
  it('snapshots membership and order without reserving or consuming a generated preview', () => {
    const batch = normal('batch-a', 'demo')
    const initialized = initialize()
    const state = generate(initialized, batch, 101)
    const [stored] = activeExamCycle(state).batches
    expect(stored.status).toBe('GENERATED')
    expect(activeExamCycle(state).reservedSourceIds).toEqual([])
    expect(activeExamCycle(state).consumedSourceIds).toEqual([])
    expect(activeExamCycle(initialized).batches).toEqual([])
    const mutableIds = batch.sections[0].questionIds as string[]
    mutableIds[0] = 'replacement'
    expect(stored.batch.sourceIds[0]).toBe('demo-1')
    expect(stored.batch.sections[0].questionIds[0]).toBe('demo-1')
    expect(Object.isFrozen(stored.batch.sections[0].questionIds)).toBe(true)
    expect(Object.isFrozen(stored.batch.optionOrder['demo-1'])).toBe(true)
    expect(isCycleLifecycle(JSON.parse(JSON.stringify(state)))).toBe(true)
  })

  it('rejects overlapping live previews, reserves only on START, and rejects replay after consumption', () => {
    const batch = normal('batch-a', 'same')
    let state = generate(initialize(), batch, 101)
    expect(transitionCycleLifecycle(state, { type: 'GENERATE', batch: normal('duplicate', 'same'), at: 102 }))
      .toEqual({ ok: false, reason: 'ACTIVE_BATCH_EXISTS' })
    state = generate(state, normal('batch-b', 'different'), 102)
    state = step(state, { type: 'START', batchId: batch.id, at: 103 })
    expect(activeExamCycle(state).reservedSourceIds).toEqual(batch.sourceIds)
    expect(activeExamCycle(state).consumedSourceIds).toEqual([])
    expect(transitionCycleLifecycle(state, { type: 'START', batchId: 'batch-b', at: 104 }))
      .toEqual({ ok: false, reason: 'ACTIVE_BATCH_EXISTS' })
    state = step(state, { type: 'COMPLETE', batchId: batch.id, at: 105 })
    expect(activeExamCycle(state).reservedSourceIds).toEqual([])
    expect(activeExamCycle(state).consumedSourceIds).toEqual(batch.sourceIds)
    // A disjoint preview can run only after the first one commits.
    expect(transitionCycleLifecycle(state, { type: 'START', batchId: 'batch-b', at: 106 }).ok).toBe(true)
    expect(transitionCycleLifecycle(state, { type: 'GENERATE', batch: normal('batch-c', 'same'), at: 106 }))
      .toEqual({ ok: false, reason: 'QUESTION_ALREADY_USED' })
  })

  it('restores old overlapping Phase 4 drafts without allowing either to replay consumed questions', () => {
    let state = generate(initialize(), normal('first', 'legacy'), 101)
    state = generate(state, normal('second', 'unrelated'), 102)
    const clone = JSON.parse(JSON.stringify(state))
    clone.cycles[0].batches[1].batch = normal('second', 'legacy')
    expect(isCycleLifecycle(clone)).toBe(true)
    state = step(clone, { type: 'START', batchId: 'first', at: 103 })
    state = step(state, { type: 'COMPLETE', batchId: 'first', at: 104 })
    expect(transitionCycleLifecycle(state, { type: 'START', batchId: 'second', at: 105 }))
      .toEqual({ ok: false, reason: 'QUESTION_ALREADY_USED' })
  })

  it.each(['ABANDON', 'INVALIDATE'] as const)('retires every started source ID on %s', (type) => {
    const batch = normal('batch-a', 'exposed')
    let state = generate(initialize(), batch, 101)
    state = step(state, { type: 'START', batchId: batch.id, at: 102 })
    state = step(state, { type, batchId: batch.id, at: 103 })
    expect(activeExamCycle(state).reservedSourceIds).toEqual([])
    expect(activeExamCycle(state).consumedSourceIds).toEqual(batch.sourceIds)
    expect(activeExamCycle(state).batches[0].status).toBe(type === 'ABANDON' ? 'ABANDONED' : 'INVALIDATED')
    expect(transitionCycleLifecycle(state, { type: 'GENERATE', batch: normal('batch-c', 'exposed'), at: 104 }))
      .toEqual({ ok: false, reason: 'QUESTION_ALREADY_USED' })
  })

  it('invalidates a never-started batch without consuming and forbids completing a preview', () => {
    const batch = normal('batch-a', 'unexposed')
    let state = generate(initialize(), batch, 101)
    expect(transitionCycleLifecycle(state, { type: 'COMPLETE', batchId: batch.id, at: 102 }))
      .toEqual({ ok: false, reason: 'INVALID_BATCH_TRANSITION' })
    state = step(state, { type: 'INVALIDATE', batchId: batch.id, at: 102 })
    expect(activeExamCycle(state).consumedSourceIds).toEqual([])
    expect(activeExamCycle(state).reservedSourceIds).toEqual([])
    expect(activeExamCycle(state).batches[0].startedAt).toBeNull()
    state = generate(state, normal('batch-b', 'unexposed'), 103)
    expect(activeExamCycle(state).batches).toHaveLength(2)
  })

  it('requires verified exhaustion after a final remainder, preserves history and permits IDs in a new explicit cycle', () => {
    const batch = remainder('remainder')
    let state = generate(initialize(), batch, 101)
    state = step(state, { type: 'START', batchId: batch.id, at: 102 })
    expect(transitionCycleLifecycle(state, { type: 'COMPLETE_CYCLE', unusedEligibleSourceIds: [], at: 102 }))
      .toEqual({ ok: false, reason: 'ACTIVE_BATCH_EXISTS' })
    state = step(state, { type: 'ABANDON', batchId: batch.id, at: 103 })
    expect(activeExamCycle(state).status).toBe('ACTIVE')
    expect(transitionCycleLifecycle(state, { type: 'COMPLETE_CYCLE', unusedEligibleSourceIds: ['remaining'], at: 103 }))
      .toEqual({ ok: false, reason: 'ELIGIBLE_CONTENT_REMAINS' })
    state = step(state, { type: 'COMPLETE_CYCLE', unusedEligibleSourceIds: [], at: 104 })
    const prior = activeExamCycle(state)
    expect(prior.status).toBe('COMPLETE')
    expect(prior.completionReason).toBe('NO_ELIGIBLE_UNUSED_CONTENT')
    expect(prior.consumedSourceIds).toEqual(batch.sourceIds)
    expect(transitionCycleLifecycle(state, { type: 'START', batchId: batch.id, at: 104 }))
      .toEqual({ ok: false, reason: 'CYCLE_COMPLETE' })
    state = step(state, { type: 'START_NEW_CYCLE', cycleId: 'cycle-next', bankVersion: 'bank-v2',
      eligibilityPolicy: 'DEVELOPMENT', at: 104 })
    expect(state.cycles[0]).toEqual(prior)
    expect(activeExamCycle(state)).toMatchObject({ id: 'cycle-next', bankVersion: 'bank-v2', consumedSourceIds: [] })
    const next = { ...batch, cycleId: 'cycle-next', contentVersion: 'bank-v2', bankVersion: 'bank-v2', id: 'remainder-next', batchId: 'remainder-next' }
    state = generate(state, next, 105)
    state = step(state, { type: 'START', batchId: next.id, at: 106 })
    expect(activeExamCycle(state).reservedSourceIds).toEqual(prior.consumedSourceIds)
  })

  it('preserves a Phase 4 oversized remainder without starting any queued oversized legacy draft', () => {
    const plan = remainder('older-plan')
    let state = generate(initialize(), plan, 101)
    state = step(state, { type: 'START', batchId: plan.id, at: 102 })
    state = step(state, { type: 'COMPLETE', batchId: plan.id, at: 103 })
    state = step(state, { type: 'COMPLETE_CYCLE', unusedEligibleSourceIds: [], at: 103 })
    const clone = JSON.parse(JSON.stringify(state))
    const oldCycle = clone.cycles[0]
    const archived = oldCycle.batches[0].batch
    for (const key of ['batchId', 'bankVersion', 'batchMode', 'actualQuestionCount', 'targetQuestionCount',
      'caseStudyQuestionCount', 'standardQuestionCount', 'interactiveQuestionCount', 'unsectionedQuestionCount', 'sourceCaseStudyIds']) {
      delete archived[key]
    }
    const extra = Array.from({ length: 60 }, (_, index) => 'older-bank-' + index)
    archived.sections.splice(1, 0, { kind: 'STANDARD_BLOCK', questionIds: extra })
    archived.sourceIds.splice(1, 0, ...extra)
    archived.total = archived.sourceIds.length
    for (const key of extra) archived.interactionKinds[key] = 'SINGLE_CHOICE'
    oldCycle.consumedSourceIds = [...archived.sourceIds]
    oldCycle.completionReason = 'FINAL_REMAINDER_RETIRED'

    expect(isCycleLifecycle(clone)).toBe(true)
    expect(restoreCycleLifecycle(clone).cycles[0].consumedSourceIds).toEqual(archived.sourceIds)
    expect(archived.sourceIds).toHaveLength(63)
    expect(transitionCycleLifecycle(initialize(), { type: 'GENERATE', batch: archived, at: 101 }))
      .toEqual({ ok: false, reason: 'INVALID_BATCH' })

    const queued = structuredClone(clone)
    Object.assign(queued.cycles[0], { status: 'ACTIVE', closedAt: null, completionReason: null, consumedSourceIds: [] })
    Object.assign(queued.cycles[0].batches[0], { status: 'GENERATED', startedAt: null, endedAt: null })
    expect(isCycleLifecycle(queued)).toBe(true)
    expect(transitionCycleLifecycle(queued, { type: 'START', batchId: plan.id, at: 104 }))
      .toEqual({ ok: false, reason: 'INVALID_BATCH' })
    const cleared = step(queued, { type: 'INVALIDATE', batchId: plan.id, at: 104 })
    expect(activeExamCycle(cleared).consumedSourceIds).toEqual([])
    expect(activeExamCycle(cleared).reservedSourceIds).toEqual([])
    expect(generate(cleared, remainder('safe-new-plan'), 105).cycles[0].batches).toHaveLength(2)
  })

  it('requires exhausted inventory and no running or still-available preview before explicit closure', () => {
    const batch = normal('batch-a', 'present')
    let state = initialize()
    expect(transitionCycleLifecycle(state, { type: 'START_NEW_CYCLE', cycleId: 'cycle-next', bankVersion: 'bank-v1',
      eligibilityPolicy: 'DEVELOPMENT', at: 101 })).toEqual({ ok: false, reason: 'CYCLE_NOT_COMPLETE' })
    expect(transitionCycleLifecycle(state, { type: 'COMPLETE_CYCLE', unusedEligibleSourceIds: ['unused'], at: 101 }))
      .toEqual({ ok: false, reason: 'ELIGIBLE_CONTENT_REMAINS' })
    state = generate(state, batch, 101)
    expect(transitionCycleLifecycle(state, { type: 'COMPLETE_CYCLE', unusedEligibleSourceIds: [], at: 102 }))
      .toEqual({ ok: false, reason: 'ELIGIBLE_CONTENT_REMAINS' })
    state = step(state, { type: 'START', batchId: batch.id, at: 102 })
    expect(transitionCycleLifecycle(state, { type: 'COMPLETE_CYCLE', unusedEligibleSourceIds: [], at: 103 }))
      .toEqual({ ok: false, reason: 'ACTIVE_BATCH_EXISTS' })
    state = step(state, { type: 'COMPLETE', batchId: batch.id, at: 103 })
    state = step(state, { type: 'COMPLETE_CYCLE', unusedEligibleSourceIds: [], at: 104 })
    expect(activeExamCycle(state).completionReason).toBe('NO_ELIGIBLE_UNUSED_CONTENT')
  })

  it('rejects mismatched content and policy, malformed options and duplicate IDs', () => {
    const state = initialize()
    const batch = normal('batch-a', 'known')
    expect(transitionCycleLifecycle(state, { type: 'GENERATE', batch: { ...batch, contentVersion: 'bank-v2', bankVersion: 'bank-v2' }, at: 101 }))
      .toEqual({ ok: false, reason: 'BANK_VERSION_MISMATCH' })
    expect(transitionCycleLifecycle(state, { type: 'GENERATE', batch: {
      ...batch, mode: 'PRODUCTION', eligibilityPolicy: 'PRODUCTION',
    }, at: 101 })).toEqual({ ok: false, reason: 'ELIGIBILITY_POLICY_MISMATCH' })
    expect(transitionCycleLifecycle(state, { type: 'GENERATE', batch: {
      ...batch, optionOrder: { [batch.sourceIds[0]]: ['option-1', 'option-1'] },
    }, at: 101 })).toEqual({ ok: false, reason: 'INVALID_BATCH' })
    const next = generate(state, batch, 101)
    expect(transitionCycleLifecycle(next, { type: 'GENERATE', batch, at: 102 }))
      .toEqual({ ok: false, reason: 'BATCH_ALREADY_EXISTS' })
  })

  it('rejects corrupted consumed/pinned state and preserves a frozen honest reload', () => {
    const batch = normal('batch-a', 'saved')
    const state = generate(initialize(), batch, 101)
    const hydrated = restoreCycleLifecycle(JSON.parse(JSON.stringify(state)))
    expect(hydrated).toEqual(state)
    expect(Object.isFrozen(hydrated.cycles[0].batches[0].batch.sourceIds)).toBe(true)
    expect(isCycleLifecycle({
      ...state,
      cycles: [{ ...activeExamCycle(state), consumedSourceIds: [batch.sourceIds[0]] }],
    })).toBe(false)
    expect(isCycleLifecycle({
      ...state,
      cycles: [{ ...activeExamCycle(state), bankVersion: 'other-bank' }],
    })).toBe(false)
  })

  it('distinguishes exact compatibility, recoverable historical selection and unavailable pin', () => {
    expect(cycleCompatibility('bank-v1', 'bank-v1')).toBe('COMPATIBLE')
    expect(cycleCompatibility('bank-v1', 'bank-v2', true)).toBe('MIGRATION_REQUIRED')
    expect(cycleCompatibility('bank-v1', 'bank-v2')).toBe('INCOMPATIBLE')
  })
})
