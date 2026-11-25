import { describe, expect, it } from 'vitest'
import { allocateRoles } from '../src/domain/batch-allocation'
import type { RoleCandidate } from '../src/domain/batch-allocation'
import {
  generateBatch,
  INTERACTIVE_PRIORITY,
  prepareBatchInventory,
} from '../src/domain/batch-engine'
import type { BatchBank, BatchGenerationInput, BatchQuestion } from '../src/domain/batch-engine'
import { validateNormalBatch } from '../src/domain/attempt'

const bankVersion = 'synthetic-bank-foundation'

function question(sourceId: string, fields?: Partial<BatchQuestion>): BatchQuestion {
  return {
    sourceId,
    interactionKind: 'SINGLE_CHOICE',
    developmentValidated: true,
    productionEligible: false,
    standardEligible: false,
    ...fields,
  }
}

function family(id: string, childIds: readonly string[]) {
  return { id, childIds, developmentValidated: true, productionEligible: false }
}

function pool(prefix: string, count: number, fields?: Partial<BatchQuestion>) {
  return Array.from({ length: count }, (_, i) => question(`${prefix}-${i}`, fields))
}

function makeBank(children = 3, standard = 49, interactive = 4): BatchBank {
  const a = pool('case-a', children)
  const b = pool('case-b', children)
  return {
    version: bankVersion,
    questions: [
      ...a, ...b,
      ...pool('standard', standard, { standardEligible: true }),
      ...pool('interactive', interactive, { interactionKind: 'MATCHING', interactiveEligible: true }),
    ],
    caseStudies: [family('a', a.map((q) => q.sourceId)), family('b', b.map((q) => q.sourceId))],
  }
}

function input(bank: BatchBank, seed = 0): BatchGenerationInput {
  return {
    bank,
    seed,
    eligibilityPolicy: 'DEVELOPMENT',
    cycleState: { cycleId: 'synthetic-cycle', bankVersion: bank.version, consumedSourceIds: [], reservedSourceIds: [] },
  }
}

function generated(i: BatchGenerationInput) {
  const out = generateBatch(i)
  if (!out.ok) throw new Error(out.reason)
  return out
}

function normal(i: BatchGenerationInput) {
  const out = generated(i)
  if (out.batch.kind !== 'NORMAL_BATCH') throw new Error(out.batch.normalFailure)
  return out.batch
}

describe('phase 4 deterministic role allocation', () => {
  it('preserves exact cardinality, source identity, fixed section order and eligibility over 128 seeds', () => {
    const base = makeBank(8, 72, 10)
    const extra = question('review-held', { standardEligible: true, held: true })
    const bank = { ...base, questions: [...base.questions, extra] }
    const reversed = {
      ...bank,
      questions: [...bank.questions].reverse(),
      caseStudies: [...bank.caseStudies].reverse().map((x) => ({ ...x, childIds: [...x.childIds].reverse() })),
    }
    const seen = new Set<string>()
    for (let seed = 0; seed < 128; seed += 1) {
      const i = input(bank, seed)
      const enriched = {
        ...i,
        cycleState: { ...i.cycleState, consumedSourceIds: ['case-a-0', 'standard-0'], reservedSourceIds: ['interactive-0', 'case-b-0'] },
      }
      const selected = normal(enriched)
      expect(normal({ ...enriched, bank: reversed })).toEqual(selected)
      expect(validateNormalBatch(selected)).toEqual({ ok: true })
      expect(selected.sections.map(({ questionIds }) => questionIds.length)).toEqual([3, 3, 49, 4])
      expect(selected.total).toBe(59)
      expect(new Set(selected.sourceIds).size).toBe(59)
      expect(selected.sections[0]?.caseStudyId).not.toBe(selected.sections[1]?.caseStudyId)
      expect(selected.sourceIds).not.toContain('case-a-0')
      expect(selected.sourceIds).not.toContain('case-b-0')
      expect(selected.sourceIds).not.toContain('standard-0')
      expect(selected.sourceIds).not.toContain('interactive-0')
      expect(selected.sourceIds).not.toContain('review-held')
      expect(Object.isFrozen(selected.sections)).toBe(true)
      expect(Object.isFrozen(selected.sections[0]!.questionIds)).toBe(true)
      seen.add(selected.id)
    }
    expect(seen.size).toBe(128)
  })

  it('uses an exact assignment to preserve scarce standard membership over interactive preference', () => {
    const basic = makeBank()
    const premium: BatchQuestion = {
      ...basic.questions.find((q) => q.sourceId === 'standard-0')!,
      interactionKind: 'IMAGE_HOTSPOT',
      interactiveEligible: true,
    }
    const bank = { ...basic, questions: basic.questions.map((q) => q.sourceId === premium.sourceId ? premium : q) }
    const constrained = normal(input(bank))
    expect(constrained.sections[2]!.questionIds).toContain(premium.sourceId)
    expect(constrained.sections[3]!.questionIds).not.toContain(premium.sourceId)
    const relaxed = normal(input({
      ...bank, questions: [...bank.questions, question('standard-spare', { standardEligible: true })],
    }))
    expect(relaxed.sections[3]!.questionIds[0]).toBe(premium.sourceId)
  })

  it('searches different family pairs before sacrificing top interactive tier', () => {
    const base = makeBank()
    const topFromCase = base.questions.find((q) => q.sourceId === 'case-a-0')!
    const c = pool('case-c', 3)
    const bank: BatchBank = {
      ...base,
      questions: [
        ...base.questions.map((q) => q === topFromCase
          ? { ...q, interactiveEligible: true, interactionKind: 'IMAGE_HOTSPOT' as const }
          : q),
        ...c,
      ],
      caseStudies: [...base.caseStudies, family('c', c.map((q) => q.sourceId))],
    }
    const result = normal(input(bank))
    expect(result.sections.slice(0, 2).map(({ caseStudyId }) => caseStudyId)).not.toContain('a')
    expect(result.sections[3]!.questionIds[0]).toBe(topFromCase.sourceId)
  })

  it('prioritizes interaction types independently of input ordering and seed', () => {
    const base = makeBank(3, 49, 0)
    const interactive = INTERACTIVE_PRIORITY.map((interactionKind, index) =>
      question(`priority-${index}`, { interactionKind, interactiveEligible: true }))
    const bank = { ...base, questions: [...base.questions, ...interactive.reverse()] }
    const result = normal(input(bank, 971))
    expect(result.sections[3]!.questionIds.map((id) => result.interactionKinds[id])).toEqual(INTERACTIVE_PRIORITY.slice(0, 4))
  })

  it('detects an impossible joint assignment even when role pool counts individually look sufficient', () => {
    const base = makeBank(3, 49, 3)
    const questions = base.questions.map((q): BatchQuestion => q.sourceId === 'standard-0'
      ? { ...q, interactionKind: 'MATCHING', interactiveEligible: true }
      : q)
    const { batch, diagnostics } = generated(input({ ...base, questions }))
    expect(batch.kind).toBe('FINAL_REMAINDER_BATCH')
    expect(diagnostics.normalFailure).toBe('CROSS_SECTION_ALLOCATION_UNSATISFIABLE')
    expect(diagnostics.eligibleUnusedStandardQuestions).toBe(49)
    expect(diagnostics.eligibleUnusedInteractiveQuestions).toBe(4)
    expect(new Set(batch.sourceIds).size).toBe(58)
  })

  it('handles 59 and 60 eligible questions without duplicate or oversized normals', () => {
    expect(normal(input(makeBank())).total).toBe(59)
    expect(normal(input(makeBank(3, 50, 4))).total).toBe(59)
  })
})

describe('phase 4 remainder and eligibility', () => {
  it('keeps intact case groups, excludes held/reserved/consumed IDs, and does not fabricate a second family', () => {
    const bank = makeBank(3, 47, 4)
    const modified = { ...bank, caseStudies: bank.caseStudies.slice(0, 1) }
    const i = input(modified)
    const prepared = prepareBatchInventory({
      ...i,
      cycleState: { ...i.cycleState, consumedSourceIds: ['case-a-0'], reservedSourceIds: ['interactive-0'] },
    })
    expect(prepared.ok && prepared.inventory.caseFamilies[0]?.questionIds).toEqual(['case-a-1', 'case-a-2'])
    const out = generated({
      ...i,
      cycleState: { ...i.cycleState, consumedSourceIds: ['case-a-0'], reservedSourceIds: ['interactive-0'] },
    })
    expect(out.batch.kind).toBe('FINAL_REMAINDER_BATCH')
    expect(out.batch.sections.filter((x) => x.caseStudyId)).toHaveLength(1)
    expect(out.batch.sections.at(-1)?.kind).toBe('FINAL_INTERACTIVE_BLOCK')
    expect(out.batch.sourceIds).not.toContain('case-a-0')
    expect(out.batch.sourceIds).not.toContain('interactive-0')
    expect(new Set(out.batch.sourceIds).size).toBe(modified.questions.length - 2)
    expect(out.diagnostics.constraints).toEqual([
      'CASE_STUDY_CHILDREN_EXHAUSTED', 'STANDARD_POOL_INSUFFICIENT', 'INTERACTIVE_POOL_EXHAUSTED',
    ])
  })

  it('reports individual category shortages and a family with only two available children', () => {
    const notEnoughInteractive = generated(input(makeBank(3, 49, 3)))
    expect(notEnoughInteractive.diagnostics.normalFailure).toBe('INTERACTIVE_POOL_EXHAUSTED')
    const notEnoughStandard = generated(input(makeBank(3, 48, 4)))
    expect(notEnoughStandard.diagnostics.normalFailure).toBe('STANDARD_POOL_INSUFFICIENT')
    const i = input(makeBank())
    const caseShortage = generated({ ...i, cycleState: { ...i.cycleState, consumedSourceIds: ['case-b-2'] } })
    expect(caseShortage.diagnostics.normalFailure).toBe('CASE_STUDY_CHILDREN_EXHAUSTED')
  })

  it('does not promote development approvals into production or bypass a review hold', () => {
    const base = makeBank()
    const i = input(base)
    expect(generateBatch({ ...i, eligibilityPolicy: 'PRODUCTION' }))
      .toMatchObject({ ok: false, reason: 'INSUFFICIENT_PRODUCTION_CONTENT', diagnostics: { excludedProductionIneligible: 59 } })
    const eligible = {
      ...base,
      questions: base.questions.map((q) => ({ ...q, developmentValidated: false, productionEligible: true })),
      caseStudies: base.caseStudies.map((x) => ({ ...x, developmentValidated: false, productionEligible: true })),
    }
    expect(normal({ ...input(eligible), eligibilityPolicy: 'PRODUCTION' }).total).toBe(59)
    expect(generateBatch(input(eligible))).toMatchObject({ ok: false, reason: 'CYCLE_EXHAUSTED' })
    const held = eligible.questions.map((q, i) => i === 0 ? { ...q, held: true } : q)
    const outcome = generated({ ...input({ ...eligible, questions: held }), eligibilityPolicy: 'PRODUCTION' })
    expect(outcome.batch.sourceIds).not.toContain(held[0]!.sourceId)
    expect(outcome.diagnostics.excludedReviewStatus).toBe(1)
  })

  it('rejects duplicate source identities, invalid version pins, and invalid bank relation data', () => {
    const base = makeBank()
    const i = input(base)
    expect(generateBatch(input({ ...base, questions: [...base.questions, base.questions[0]!] })))
      .toMatchObject({ ok: false, reason: 'DUPLICATE_SOURCE_ID' })
    expect(generateBatch({ ...i, cycleState: { ...i.cycleState, bankVersion: 'wrong-version' } }))
      .toMatchObject({ ok: false, reason: 'INVALID_BANK_VERSION' })
    expect(generateBatch(input({ ...base, caseStudies: [...base.caseStudies, family('unknown', ['no-such-id'])] })))
      .toMatchObject({ ok: false, reason: 'INVALID_BANK' })
    expect(generateBatch(input({ ...base, caseStudies: [...base.caseStudies, family('duplicate-member', ['case-a-0'])] })))
      .toMatchObject({ ok: false, reason: 'INVALID_BANK' })
    expect(generateBatch({ ...i, cycleState: { ...i.cycleState, status: 'COMPLETE' } }))
      .toMatchObject({ ok: false, reason: 'CYCLE_COMPLETE' })
  })

  it('never reuses a selected source item across sequential normal instances and an explicit remainder', () => {
    const i = input(makeBank(10, 150, 13), 41)
    const used = new Set<string>()
    for (let index = 0; index < 3; index += 1) {
      const batch = normal({ ...i, seed: index, cycleState: { ...i.cycleState, consumedSourceIds: [...used] } })
      for (const id of batch.sourceIds) {
        expect(used.has(id)).toBe(false)
        used.add(id)
      }
    }
    expect(used.size).toBe(177)
    const { batch } = generated({ ...i, cycleState: { ...i.cycleState, consumedSourceIds: [...used] } })
    expect(batch.kind).toBe('FINAL_REMAINDER_BATCH')
    expect(batch.total).toBe(6)
    expect(batch.sourceIds.every((id) => !used.has(id))).toBe(true)
    batch.sourceIds.forEach((id) => used.add(id))
    expect(generateBatch({ ...i, cycleState: { ...i.cycleState, consumedSourceIds: [...used] } }))
      .toMatchObject({ ok: false, reason: 'CYCLE_EXHAUSTED' })
  })

  it('copies option display identity lists, isolates target groups, and freezes started membership inputs', () => {
    const base = makeBank()
    const ids = ['alpha', 'beta', 'gamma']
    const fixed = ['epsilon', 'delta']
    const q: BatchQuestion = {
      ...base.questions[0]!,
      optionGroups: [{ id: 'first', shuffle: true, optionIds: ids }, { id: 'fixed', shuffle: false, optionIds: fixed }],
    }
    const bank = { ...base, questions: [q, ...base.questions.slice(1)] }
    const batch = normal(input(bank, 192))
    const order = batch.optionOrder[q.sourceId]!
    expect(new Set(order.slice(0, 3))).toEqual(new Set(ids))
    expect(order.slice(3)).toEqual(fixed)
    expect(Object.isFrozen(order)).toBe(true)
    expect(Object.isFrozen(batch.optionOrder)).toBe(true)
    expect(Object.isFrozen(batch)).toBe(true)
    ids.push('late-mutation')
    fixed.reverse()
    expect(order).not.toContain('late-mutation')
    expect(order.slice(3)).toEqual(['epsilon', 'delta'])
  })
})

describe('exact role allocation oracle', () => {
  function minimumCost(roles: readonly RoleCandidate[], ids: readonly string[]): number {
    const quotas = roles.map(({ quota }) => quota)
    let best = Infinity
    function visit(offset: number, running: number) {
      if (running >= best) return
      if (quotas.every((n) => n === 0)) {
        best = running
        return
      }
      if (offset >= ids.length) return
      visit(offset + 1, running)
      const id = ids[offset]!
      for (const [index, role] of roles.entries()) {
        if (quotas[index]! === 0 || !role.questionIds.includes(id)) continue
        quotas[index] = quotas[index]! - 1
        visit(offset + 1, running + (role.costByQuestion?.get(id) ?? 0))
        quotas[index] = quotas[index]! + 1
      }
    }
    visit(0, 0)
    return best
  }

  it('matches exact weighted feasibility from 96 tiny exhaustive synthetic graphs', () => {
    const ids = Array.from({ length: 7 }, (_, index) => `x-${index}`)
    let state = 9901
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
    for (let trial = 0; trial < 96; trial += 1) {
      const roles: RoleCandidate[] = Array.from({ length: 3 }, (_, index) => ({
        id: `role-${index}`,
        quota: (next() >>> 28) % 3,
        questionIds: ids.filter(() => next() >>> 30 > 0),
        costByQuestion: new Map(ids.map((id) => [id, next() >>> 28])),
      }))
      const optimum = minimumCost(roles, ids)
      const result = allocateRoles(roles)
      if (!Number.isFinite(optimum)) expect(result).toBeNull()
      else {
        expect(result).not.toBeNull()
        const used = roles.flatMap(({ id }) => result!.get(id)!)
        expect(used.length).toBe(new Set(used).size)
        const actual = roles.reduce((sum, role) => sum + result!.get(role.id)!
          .reduce((subtotal, id) => subtotal + (role.costByQuestion?.get(id) ?? 0), 0), 0)
        expect(actual).toBe(optimum)
      }
      const feasibilityOnly = allocateRoles(roles.map(({ id, quota, questionIds }) => ({ id, quota, questionIds })))
      expect(Boolean(feasibilityOnly)).toBe(Number.isFinite(optimum))
    }
  })
})
