import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { generateBatch } from '../src/domain/batch-engine'
import type { BatchBank, BatchQuestion } from '../src/domain/batch-engine'
import { analyzeCycleCapacity } from '../src/domain/cycle-capacity'
import { generateCycleBatch } from '../src/domain/cycle-plan'
import {
  activeExamCycle, createCycleLifecycle, transitionCycleLifecycle,
  type CycleLifecycle, type CycleLifecycleCommand,
} from '../src/domain/cycle-lifecycle'
import { createCycleRepository } from '../src/storage/cycle-repository'

const version = 'synthetic-invariants-bank-v1'
type Input = Parameters<typeof generateBatch>[0]
const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`)
const caseChild = (sourceId: string): BatchQuestion => ({
  sourceId,
  interactionKind: 'SINGLE_CHOICE',
  developmentValidated: true,
  productionEligible: false,
  standardEligible: false,
})
const standard = (sourceId: string): BatchQuestion => ({
  ...caseChild(sourceId),
  standardEligible: true,
  optionGroups: [{ id: 'options', optionIds: ['slot-a', 'slot-b', 'slot-c', 'slot-d'], shuffle: true }],
})
const interactive = (sourceId: string, interactionKind: BatchQuestion['interactionKind'] = 'MATCHING'): BatchQuestion => ({
  ...caseChild(sourceId),
  interactionKind,
  interactiveEligible: true,
})
function fixture({ families = [6, 6], standardCount = 100, interactiveCount = 10 }: {
  families?: readonly number[]
  standardCount?: number
  interactiveCount?: number
} = {}): BatchBank {
  const caseStudies = families.map((count, i) => ({
    id: 'family-' + i,
    childIds: ids('case-' + i, count),
    developmentValidated: true,
    productionEligible: false,
  }))
  return {
    version,
    caseStudies,
    questions: [
      ...caseStudies.flatMap(family => family.childIds.map(caseChild)),
      ...ids('std', standardCount).map(standard),
      ...ids('interactive', interactiveCount).map(sourceId => interactive(sourceId)),
    ],
  }
}
function input(bank: BatchBank, seed: number | string, extras: Partial<Input['cycleState']> = {}): Input {
  return {
    bank,
    eligibilityPolicy: 'DEVELOPMENT',
    seed,
    cycleState: {
      cycleId: 'synthetic-cycle',
      bankVersion: bank.version,
      consumedSourceIds: [],
      reservedSourceIds: [],
      status: 'ACTIVE',
      ...extras,
    },
  }
}
function success(data: Input) {
  const result = generateBatch(data)
  if (!result.ok) throw new Error(`Expected a batch, received ${result.reason}`)
  return result.batch
}
function assertNormal(batch: ReturnType<typeof success>, data: Input) {
  if (batch.kind !== 'NORMAL_BATCH') throw new Error('Expected normal-batch section shape')
  expect(batch.total).toBe(59)
  expect(batch.sourceIds).toHaveLength(59)
  expect(new Set(batch.sourceIds).size).toBe(59)
  expect(batch.sections.map(section => section.kind)).toEqual([
    'CASE_STUDY_1', 'CASE_STUDY_2', 'STANDARD_BLOCK', 'FINAL_INTERACTIVE_BLOCK',
  ])
  expect(batch.sections.map(section => section.questionIds.length)).toEqual([3, 3, 49, 4])
  expect(batch.sections.flatMap(section => section.questionIds)).toEqual(batch.sourceIds)
  expect(batch.sections[0].caseStudyId).not.toBe(batch.sections[1].caseStudyId)
  const seen = new Set([...data.cycleState.consumedSourceIds, ...data.cycleState.reservedSourceIds])
  const questions = new Map(data.bank.questions.map(question => [question.sourceId, question]))
  for (const id of batch.sourceIds) {
    expect(seen.has(id)).toBe(false)
    expect(questions.get(id)?.developmentValidated).toBe(true)
    expect(questions.get(id)?.held).not.toBe(true)
    seen.add(id)
  }
  for (const section of batch.sections.slice(0, 2)) {
    const family = data.bank.caseStudies.find(row => row.id === section.caseStudyId)
    expect(family?.developmentValidated).toBe(true)
    expect(section.questionIds.every(id => family?.childIds.includes(id))).toBe(true)
  }
  expect(batch.sections[2].questionIds.every(id => questions.get(id)?.standardEligible)).toBe(true)
  expect(batch.sections[3].questionIds.every(id => questions.get(id)?.interactiveEligible)).toBe(true)
}

describe('Phase 4 independently authored generator invariants', () => {
  it('reproduces 128 seeded normal batches and does not collapse all seeds to one ordering', () => {
    const bank = fixture()
    const shapes = new Set<string>()
    for (let seed = 0; seed < 128; seed++) {
      const data = input(bank, seed)
      const batch = success(data)
      assertNormal(batch, data)
      expect(success(structuredClone(data))).toEqual(batch)
      shapes.add(JSON.stringify(batch.sourceIds))
    }
    expect(shapes.size).toBeGreaterThan(1)
  })

  it('treats equivalent pool and consumed-list orders deterministically', () => {
    const bank = fixture()
    const consumed = ['std-1', 'interactive-1']
    const reordered: BatchBank = {
      ...bank,
      questions: [...bank.questions].reverse(),
      caseStudies: [...bank.caseStudies].reverse()
        .map(family => ({ ...family, childIds: [...family.childIds].reverse() })),
    }
    const a = success(input(bank, 'canonical-order', { consumedSourceIds: consumed }))
    const b = success(input(reordered, 'canonical-order', { consumedSourceIds: [...consumed].reverse() }))
    expect(a).toEqual(b)
  })

  it('supports two compliant normal batches then an exact remainder without cross-batch reuse, across twelve seeds', () => {
    const bank = fixture()
    for (let seed = 0; seed < 12; seed++) {
      const first = success(input(bank, seed))
      assertNormal(first, input(bank, seed))
      const consumed = [...first.sourceIds]
      const next = input(bank, seed, { consumedSourceIds: consumed })
      const second = success(next)
      assertNormal(second, next)
      consumed.push(...second.sourceIds)
      expect(new Set(consumed).size).toBe(118)
      const last = success(input(bank, seed, { consumedSourceIds: consumed }))
      expect(last.kind).toBe('FINAL_REMAINDER_BATCH')
      expect(last.total).toBe(4)
      expect(new Set(last.sourceIds).size).toBe(4)
      expect(last.sourceIds.every(id => !consumed.includes(id))).toBe(true)
      expect(new Set([...consumed, ...last.sourceIds]).size).toBe(bank.questions.length)
      expect(generateBatch(input(bank, seed, { consumedSourceIds: [...consumed, ...last.sourceIds] })).ok).toBe(false)
    }
  })

  it('makes a globally feasible allocation before honoring higher interactive preferences', () => {
    const base = fixture({ families: [3, 3], standardCount: 45, interactiveCount: 0 })
    const bank: BatchBank = { ...base, questions: [
      ...base.questions,
      ...ids('overlap-high-priority', 4).map(sourceId => ({
        ...interactive(sourceId, 'IMAGE_HOTSPOT'),
        standardEligible: true,
      })),
      ...ids('interactive-low-priority', 4).map(sourceId => interactive(sourceId, 'STATEMENT')),
    ] }
    for (const seed of [0, 1, 99]) {
      const data = input(bank, seed)
      const batch = success(data)
      assertNormal(batch, data)
      expect(batch.sections[2].questionIds.filter(id => id.startsWith('overlap-high-priority'))).toHaveLength(4)
      expect(batch.sections[3].questionIds.every(id => id.startsWith('interactive-low-priority'))).toBe(true)
    }
  })

  it('honors higher interactive tiers when they do not prevent a valid allocation', () => {
    const base = fixture({ families: [3, 3], standardCount: 49, interactiveCount: 0 })
    const bank: BatchBank = { ...base, questions: [
      ...base.questions,
      ...ids('hotspot-full-coverage', 4).map(id => interactive(id, 'DROPDOWN_HOTSPOT')),
      ...ids('statement-other', 6).map(id => interactive(id, 'STATEMENT')),
    ] }
    const data = input(bank, 301)
    const batch = success(data)
    assertNormal(batch, data)
    expect(batch.sections[3].questionIds.every(id => id.startsWith('hotspot-full-coverage'))).toBe(true)
  })

  it('recognizes individually sufficient role counts that cannot be satisfied jointly', () => {
    const base = fixture({ families: [3, 3], standardCount: 48, interactiveCount: 3 })
    const bank: BatchBank = { ...base, questions: [
      ...base.questions,
      { ...interactive('limited-dual'), standardEligible: true },
    ] }
    const batch = success(input(bank, 44))
    expect(batch.kind).toBe('FINAL_REMAINDER_BATCH')
    expect(batch.total).toBe(58)
    expect(new Set(batch.sourceIds).size).toBe(58)
  })

  it.each([
    { name: 'one family', families: [4], standardCount: 49, interactiveCount: 4, available: 57 },
    { name: 'a family with only two children', families: [3, 2], standardCount: 49, interactiveCount: 4, available: 58 },
    { name: 'fewer than 49 standard questions', families: [3, 3], standardCount: 48, interactiveCount: 4, available: 58 },
    { name: 'fewer than four interactive questions', families: [3, 3], standardCount: 49, interactiveCount: 3, available: 58 },
  ])('relaxes section cardinality only in remainder: $name', ({ families, standardCount, interactiveCount, available }) => {
    const bank = fixture({ families, standardCount, interactiveCount })
    const batch = success(input(bank, 81))
    expect(batch.kind).toBe('FINAL_REMAINDER_BATCH')
    expect(batch.total).toBe(available)
    expect(new Set(batch.sourceIds)).toEqual(new Set(bank.questions.map(question => question.sourceId)))
  })

  it('handles exactly 59 then 60 distinct eligible source IDs, with no fabricated filler', () => {
    for (const extra of [0, 1]) {
      const bank = fixture({ families: [3, 3], standardCount: 49 + extra, interactiveCount: 4 })
      const data = input(bank, 921)
      const batch = success(data)
      assertNormal(batch, data)
      const next = generateBatch(input(bank, 921, { consumedSourceIds: batch.sourceIds }))
      if (extra === 0) {
        expect(next.ok).toBe(false)
      } else {
        expect(next.ok).toBe(true)
        if (!next.ok) throw new Error('One unused item should be returned exactly once')
        expect(next.batch.kind).toBe('FINAL_REMAINDER_BATCH')
        expect(next.batch.total).toBe(1)
        expect(batch.sourceIds).not.toContain(next.batch.sourceIds[0])
      }
    }
  })

  it('filters held and ineligible content and refuses a distinct active reservation', () => {
    const base = fixture({ families: [3, 3], standardCount: 50, interactiveCount: 4 })
    const bank: BatchBank = { ...base, questions: [
      ...base.questions,
      { ...standard('held-standard'), held: true },
      { ...standard('review-required-standard'), developmentValidated: false },
    ] }
    const data = input(bank, 12, { reservedSourceIds: ['std-1'] })
    const result = generateBatch(data)
    if (!result.ok) {
      // Lifecycle may reject generation whenever a batch already owns any reservation.
      expect(result.reason).toMatch(/RESERV|ACTIVE|STARTED/)
      return
    }
    assertNormal(result.batch, data)
    expect(result.batch.sourceIds).not.toContain('std-1')
    expect(result.batch.sourceIds).not.toContain('held-standard')
    expect(result.batch.sourceIds).not.toContain('review-required-standard')
  })

  it('rejects duplicate IDs, a mismatched bank version, and no production-approved content', () => {
    const bank = fixture()
    const a = generateBatch(input({ ...bank, questions: [...bank.questions, bank.questions[0]] }, 1))
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.reason).toMatch(/DUPLICATE|INVALID_BANK/)
    const b = generateBatch(input(bank, 1, { bankVersion: 'different-version' }))
    expect(b).toMatchObject({ ok: false, reason: 'INVALID_BANK_VERSION' })
    const c = generateBatch({ ...input(bank, 44), eligibilityPolicy: 'PRODUCTION' })
    expect(c).toMatchObject({ ok: false, reason: 'INSUFFICIENT_PRODUCTION_CONTENT' })
  })
})

describe('Independent capacity cross-checks', () => {
  it('constructs a disjoint witness for two full batches and marks both exact bottlenecks and four remaining items', () => {
    const data = input(fixture(), 'capacity')
    const capacity = analyzeCycleCapacity(data)
    if (!capacity.ok) throw new Error('Capacity must admit the known disjoint construction')
    expect(capacity.maximumFullBatches).toBe(2)
    expect(capacity.anticipatedRemainder.size).toBe(4)
    expect(capacity.witness).toHaveLength(2)
    const used = capacity.witness.flatMap(sections => {
      expect(sections.map(section => section.questionIds.length)).toEqual([3, 3, 49, 4])
      expect(sections[0].caseStudyId).not.toBe(sections[1].caseStudyId)
      return sections.flatMap(section => section.questionIds)
    })
    expect(new Set(used).size).toBe(118)
    expect(new Set([...used, ...capacity.anticipatedRemainder.sourceIds]).size).toBe(122)
  })

  it('will not take a locally valid pair that strands a second full cycle batch', () => {
    // The six-child family must appear twice, once with each of the three-child
    // families. Pairing the two small families is feasible now but wastes capacity.
    const bank = fixture({ families: [6, 3, 3], standardCount: 98, interactiveCount: 8 })
    const unmatched = []
    for (let seed = 0; seed < 32; seed++) {
      const local = success(input(bank, seed))
      if (!local.sections.slice(0, 2).some(section => section.caseStudyId === 'family-0')) unmatched.push(seed)
    }
    expect(unmatched.length).toBeGreaterThan(0)
    for (const seed of unmatched) {
      const planned = generateCycleBatch(input(bank, seed))
      expect(planned.ok).toBe(true)
      if (!planned.ok) throw new Error('Expected a capacity-preserving plan')
      expect(planned.batch.sections.slice(0, 2).some(section => section.caseStudyId === 'family-0')).toBe(true)
      const next = generateCycleBatch(input(bank, seed, { consumedSourceIds: planned.batch.sourceIds }))
      expect(next.ok).toBe(true)
      if (!next.ok) throw new Error('Planner stranded remaining normal batch')
      expect(next.batch.kind).toBe('NORMAL_BATCH')
      expect(new Set([...planned.batch.sourceIds, ...next.batch.sourceIds]).size).toBe(118)
    }
  })

  it('identifies overlapping pools even when all independent quotas count enough items', () => {
    const base = fixture({ families: [3, 3], standardCount: 48, interactiveCount: 3 })
    const bank: BatchBank = { ...base, questions: [
      ...base.questions,
      { ...interactive('shared-role-only'), standardEligible: true },
      caseChild('eligible-but-not-normal-role'),
    ] }
    const capacity = analyzeCycleCapacity(input(bank, 'overlap'))
    if (!capacity.ok) throw new Error('Capacity must report explanation, not throw')
    expect(capacity.independentBounds).toEqual({
      caseStudy: 1, standard: 1, interactive: 1, totalEligible: 1,
    })
    expect(capacity.maximumFullBatches).toBe(0)
    expect(capacity.limitingConstraints).toEqual(['OVERLAPPING_POOLS'])
    expect(capacity.anticipatedRemainder.size).toBe(59)
  })
})

describe('Snapshot and eligibility invariants', () => {
  it('does not use held or unreviewed questions to satisfy a role', () => {
    const base = fixture({ families: [3, 3], standardCount: 48, interactiveCount: 3 })
    const bank: BatchBank = { ...base, questions: [
      ...base.questions,
      { ...standard('held-standard'), held: true },
      { ...interactive('unreviewed-interactive'), developmentValidated: false },
    ] }
    const batch = success(input(bank, 12))
    expect(batch.kind).toBe('FINAL_REMAINDER_BATCH')
    expect(batch.total).toBe(57)
    expect(batch.sourceIds).not.toContain('held-standard')
    expect(batch.sourceIds).not.toContain('unreviewed-interactive')
  })

  it('keeps a generated snapshot independent of mutable bank arrays and order identities', () => {
    const base = fixture({ families: [3, 3], standardCount: 49, interactiveCount: 4 })
    const mutable = ['alpha-display', 'beta-display', 'gamma-display', 'delta-display']
    const bank: BatchBank = { ...base, questions: base.questions.map(q => q.standardEligible ? {
      ...q, optionGroups: [{ id: 'options', optionIds: mutable, shuffle: true }],
    } : q) }
    const snapshot = success(input(bank, 71))
    if (snapshot.kind !== 'NORMAL_BATCH') throw new Error('Wrong batch shape')
    const before = structuredClone(snapshot)
    const keys = JSON.stringify(snapshot.optionOrder)
    expect(keys).toContain('alpha-display')
    expect(keys).toContain('delta-display')
    expect(keys).not.toContain('unauthorized-index')
    expect(mutable).toEqual(['alpha-display', 'beta-display', 'gamma-display', 'delta-display'])
    mutable.splice(1, 1, 'unauthorized-index')
    expect(snapshot).toEqual(before)
    expect(JSON.stringify(snapshot.optionOrder)).not.toContain('unauthorized-index')
    expect(snapshot.sourceIds).toHaveLength(59)
  })

  it('cannot resume generation on a completed cycle with matching-version content', () => {
    const data = input(fixture(), 1, { status: 'COMPLETE' })
    expect(generateBatch(data)).toMatchObject({ ok: false, reason: 'CYCLE_COMPLETE' })
  })
})

describe('Independent lifecycle and persistence verification', () => {
  const registryId = 'independent-cycle-registry'
  function initial(cycleId = 'synthetic-cycle') {
    return createCycleLifecycle({ id: registryId, cycleId, bankVersion: version, eligibilityPolicy: 'DEVELOPMENT', createdAt: 10 })
  }
  function apply(state: CycleLifecycle, command: CycleLifecycleCommand): CycleLifecycle {
    const next = transitionCycleLifecycle(state, command)
    if (!next.ok) throw new Error('Unexpected lifecycle failure: ' + next.reason)
    return next.state
  }

  it('invalidated previews do not consume, but abandoned or invalidated started batches permanently retire their IDs', () => {
    const bank = fixture({ families: [3, 3], standardCount: 49, interactiveCount: 4 })
    const draft = success(input(bank, 3))
    const first = apply(initial(), { type: 'GENERATE', batch: draft, at: 11 })
    expect(activeExamCycle(first).reservedSourceIds).toHaveLength(0)
    expect(activeExamCycle(first).consumedSourceIds).toHaveLength(0)
    expect(activeExamCycle(first).batches[0].status).toBe('GENERATED')
    const cancelled = apply(first, { type: 'INVALIDATE', batchId: draft.id, at: 12 })
    expect(activeExamCycle(cancelled).consumedSourceIds).toHaveLength(0)
    expect(activeExamCycle(cancelled).batches[0].status).toBe('INVALIDATED')
    const candidate = success(input(bank, 4))
    const generated = apply(cancelled, { type: 'GENERATE', batch: candidate, at: 13 })
    const started = apply(generated, { type: 'START', batchId: candidate.id, at: 14 })
    expect(activeExamCycle(started).batches[1].status).toBe('STARTED')
    expect(activeExamCycle(started).reservedSourceIds).toEqual(candidate.sourceIds)
    expect(activeExamCycle(started).consumedSourceIds).toHaveLength(0)
    for (const type of ['ABANDON', 'INVALIDATE'] as const) {
      const ended = apply(started, { type, batchId: candidate.id, at: 15 })
      expect(activeExamCycle(ended).consumedSourceIds).toEqual(candidate.sourceIds)
      expect(activeExamCycle(ended).reservedSourceIds).toHaveLength(0)
      expect(activeExamCycle(ended).batches[1].status).toBe(type === 'ABANDON' ? 'ABANDONED' : 'INVALIDATED')
      expect(transitionCycleLifecycle(ended, {
        type: 'GENERATE', batch: success(input(bank, 5)), at: 16,
      })).toMatchObject({ ok: false, reason: 'QUESTION_ALREADY_USED' })
    }
  })

  it('closes only after the final remainder and keeps its completed predecessor after an explicit new cycle', () => {
    const bank = fixture()
    for (const seed of [18, 19, 20, 21, 22, 23]) {
      let state = initial()
      let at = 10
      const historical = new Set<string>()
      const rejectPrematureNew = transitionCycleLifecycle(state, {
        type: 'START_NEW_CYCLE', cycleId: 'fresh', bankVersion: version, eligibilityPolicy: 'DEVELOPMENT', at: ++at,
      })
      expect(rejectPrematureNew).toMatchObject({ ok: false, reason: 'CYCLE_NOT_COMPLETE' })
      for (let index = 0; index < 3; index++) {
        const current = activeExamCycle(state)
        const batch = success(input(bank, seed, {
          consumedSourceIds: current.consumedSourceIds, reservedSourceIds: current.reservedSourceIds,
        }))
        expect(batch.kind).toBe(index < 2 ? 'NORMAL_BATCH' : 'FINAL_REMAINDER_BATCH')
        expect(batch.sourceIds.every(id => !historical.has(id))).toBe(true)
        state = apply(state, { type: 'GENERATE', batch, at: ++at })
        expect(activeExamCycle(state).consumedSourceIds).toHaveLength(historical.size)
        state = apply(state, { type: 'START', batchId: batch.id, at: ++at })
        expect(activeExamCycle(state).reservedSourceIds).toEqual(batch.sourceIds)
        state = apply(state, { type: 'COMPLETE', batchId: batch.id, at: ++at })
        batch.sourceIds.forEach(id => historical.add(id))
        expect(activeExamCycle(state).consumedSourceIds).toHaveLength(historical.size)
        expect(activeExamCycle(state).bankVersion).toBe(version)
      }
      const old = activeExamCycle(state)
      expect(old.status).toBe('COMPLETE')
      expect(old.completionReason).toBe('FINAL_REMAINDER_RETIRED')
      expect(historical.size).toBe(122)
      const reloaded = structuredClone(state)
      state = apply(reloaded, { type: 'START_NEW_CYCLE', cycleId: 'fresh', bankVersion: version, eligibilityPolicy: 'DEVELOPMENT', at: at + 1 })
      expect(state.cycles[0]).toEqual(old)
      expect(activeExamCycle(state).consumedSourceIds).toHaveLength(0)
      expect(activeExamCycle(state).reservedSourceIds).toHaveLength(0)
      expect(success(input(bank, seed, { cycleId: 'fresh' })).sourceIds.some(id => historical.has(id))).toBe(true)
    }
  })

  it('reopens pinned records without substitution and rejects secondary and stale writers', async () => {
    const bank = fixture({ families: [3, 3], standardCount: 49, interactiveCount: 4 })
    const generated = success(input(bank, 'persisted-phase4'))
    const factory = new IDBFactory()
    const repoConfig = { indexedDB: factory, now: () => 30 }
    const primary = createCycleRepository(repoConfig)
    const second = createCycleRepository(repoConfig)
    const starting = initial()
    const firstLease = await primary.initialize({ state: starting, writerId: 'first-tab' })
    const guard = { registryId, lease: firstLease, loadedBankVersion: version }
    await expect(second.acquireWriter(registryId, 'second-tab')).rejects.toMatchObject({ code: 'WRITER_ACTIVE' })
    const made = await primary.apply({ ...guard, expectedRevision: 0, command: { type: 'GENERATE', batch: generated, at: 31 } })
    if (!made.ok) throw new Error('Expected atomic generation persistence')
    await expect(primary.apply({
      ...guard, expectedRevision: 0, command: { type: 'START', batchId: generated.id, at: 32 },
    })).rejects.toMatchObject({ code: 'STALE_REVISION' })
    const start = await primary.apply({ ...guard, expectedRevision: made.state.revision, command: { type: 'START', batchId: generated.id, at: 32 } })
    if (!start.ok) throw new Error('Expected start reservation persistence')
    await expect(second.apply({ ...guard, expectedRevision: start.state.revision,
      lease: { ...firstLease, writerId: 'second-tab' },
      command: { type: 'COMPLETE', batchId: generated.id, at: 33 },
    })).rejects.toMatchObject({ code: 'LEASE_LOST' })
    const done = await primary.apply({ ...guard, expectedRevision: start.state.revision, command: { type: 'COMPLETE', batchId: generated.id, at: 33 } })
    if (!done.ok) throw new Error('Expected committed consumption')
    primary.close()
    const observer = createCycleRepository(repoConfig)
    const loaded = await observer.load(registryId, version)
    expect(loaded?.compatibility).toBe('COMPATIBLE')
    if (!loaded) throw new Error('Missing persisted registry on reopen')
    const current = activeExamCycle(loaded.state)
    expect(current.batches[0].batch).toEqual(generated)
    expect(current.consumedSourceIds).toEqual(generated.sourceIds)
    expect(current.reservedSourceIds).toHaveLength(0)
    expect((await observer.load(registryId, 'future-bank', true))?.compatibility).toBe('MIGRATION_REQUIRED')
    expect((await observer.load(registryId, 'future-bank', false))?.compatibility).toBe('INCOMPATIBLE')
    expect(activeExamCycle(loaded.state).bankVersion).toBe(version)
    observer.close()
    second.close()
  })
})
