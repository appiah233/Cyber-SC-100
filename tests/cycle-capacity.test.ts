import { describe, expect, it } from 'vitest'
import { analyzeCycleCapacity } from '../src/domain/cycle-capacity'
import type { CycleCapacityInput } from '../src/domain/cycle-capacity'
import { allocateRoles } from '../src/domain/batch-allocation'
import { NORMAL_SECTIONS } from '../src/domain/model'

type Q = CycleCapacityInput['bank']['questions'][number]
type F = CycleCapacityInput['bank']['caseStudies'][number]
const version = 'synthetic-capacity-v1'

function question(sourceId: string, standardEligible: boolean, interactiveEligible: boolean): Q {
  return {
    sourceId,
    interactionKind: interactiveEligible ? 'DROPDOWN_HOTSPOT' : 'SINGLE_CHOICE',
    developmentValidated: true,
    productionEligible: false,
    standardEligible,
    interactiveEligible,
  }
}

function group(prefix: string, count: number, standard = false, interactive = false): Q[] {
  return Array.from({ length: count }, (_, i) => question(`${prefix}-${i.toString().padStart(3, '0')}`, standard, interactive))
}

function family(id: string, members: readonly Q[]): F {
  return { id, childIds: members.map(({ sourceId }) => sourceId), developmentValidated: true, productionEligible: false }
}

function input(questions: readonly Q[], caseStudies: readonly F[],
  cycle: Partial<CycleCapacityInput['cycleState']> = {}): CycleCapacityInput {
  return {
    bank: { version, questions, caseStudies },
    cycleState: { cycleId: 'synthetic-cycle', bankVersion: version, consumedSourceIds: [], reservedSourceIds: [], ...cycle },
    eligibilityPolicy: 'DEVELOPMENT',
  }
}

function witnessCheck(result: ReturnType<typeof analyzeCycleCapacity>, n: number): void {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.reason)
  expect(result.maximumFullBatches).toBe(n)
  expect(result.witness).toHaveLength(n)
  const seen = new Set<string>()
  for (const batch of result.witness) {
    expect(batch.map(({ kind }) => kind)).toEqual(NORMAL_SECTIONS.map(({ kind }) => kind))
    expect(batch.map(({ questionIds }) => questionIds.length)).toEqual([3, 3, 49, 4])
    expect(batch[0].caseStudyId).not.toBe(batch[1].caseStudyId)
    for (const { questionIds } of batch) {
      for (const id of questionIds) {
        expect(seen.has(id)).toBe(false)
        seen.add(id)
      }
    }
  }
  expect(seen.size).toBe(n * 59)
  expect(result.afterNormalInventory.size).toBe(result.afterNormalInventory.sourceIds.length)
  expect(result.afterNormalInventory.sourceIds.every((id) => !seen.has(id))).toBe(true)
  expect(result.adaptiveWitness).toHaveLength(result.adaptiveFullBatches)
  for (const batch of result.adaptiveWitness) {
    const ids = batch.flatMap(({ questionIds }) => questionIds)
    expect(ids).toHaveLength(59)
    for (const id of ids) {
      expect(seen.has(id)).toBe(false)
      seen.add(id)
    }
  }
  expect(result.anticipatedRemainder.sourceIds.every((id) => !seen.has(id))).toBe(true)
  expect(result.anticipatedRemainder.size).toBe(result.anticipatedRemainder.sourceIds.length)
  expect(result.anticipatedRemainder.size).toBe(result.finalRemainderSize)
  expect(seen.size + result.finalRemainderSize).toBe(result.totalEligibleQuestions)
}

describe('exact cycle capacity', () => {
  it('constructs a globally disjoint six-batch witness and leaves all extras', () => {
    const a = group('a', 21)
    const b = group('b', 18)
    const s = group('s', 294, true)
    const i = group('i', 24, false, true)
    const f = [family('a', a), family('b', b)]
    const result = analyzeCycleCapacity(input([...a, ...b, ...s, ...i], f))
    witnessCheck(result, 6)
    if (!result.ok) throw new Error(result.reason)
    expect(result.independentBounds).toEqual({ caseStudy: 6, standard: 6, interactive: 6, totalEligible: 6 })
    expect(result.anticipatedRemainder.size).toBe(3)
    expect(Object.isFrozen(result.witness[0][0].questionIds)).toBe(true)
    expect(analyzeCycleCapacity(input([...i, ...s, ...b, ...a].reverse(), [...f].reverse()))).toEqual(result)
  })

  it('does not mistake total case children for two different families', () => {
    const a = group('a', 12)
    const b = group('b', 2)
    const s = group('s', 49, true)
    const i = group('i', 4, false, true)
    const result = analyzeCycleCapacity(input([...a, ...b, ...s, ...i], [family('a', a), family('b', b)]))
    witnessCheck(result, 0)
    if (!result.ok) throw new Error(result.reason)
    expect(result.limitingConstraints).toEqual(['CASE_STUDY'])
    expect(result).toMatchObject({ adaptiveFullBatches: 1, finalRemainderSize: 8 })
    expect(result.afterNormalInventory.size).toBe(67)
  })

  it('finds the qualifying case pair rather than spending an essential standard pool', () => {
    const a = group('a', 3, true)
    const b = group('b', 3)
    const c = group('c', 3)
    const s = group('s', 46, true)
    const i = group('i', 4, false, true)
    const result = analyzeCycleCapacity(input([...a, ...b, ...c, ...s, ...i], [family('a', a), family('b', b), family('c', c)]))
    witnessCheck(result, 1)
    if (!result.ok) throw new Error(result.reason)
    expect(result.witness[0].slice(0, 2).map(({ caseStudyId }) => caseStudyId)).toEqual(['b', 'c'])
    expect(result.witness[0][2].questionIds).toEqual(expect.arrayContaining(a.map(({ sourceId }) => sourceId)))
  })

  it('does not call simultaneous overlapping pools feasible even when all marginal bounds pass', () => {
    const a = group('a', 7)
    const b = group('b', 3)
    const shared = group('shared', 4, true, true)
    const s = group('s', 45, true)
    const result = analyzeCycleCapacity(input([...a, ...b, ...s, ...shared], [family('a', a), family('b', b)]))
    witnessCheck(result, 0)
    if (!result.ok) throw new Error(result.reason)
    expect(result.independentBounds).toEqual({ caseStudy: 1, standard: 1, interactive: 1, totalEligible: 1 })
    expect(result.limitingConstraints).toEqual(['OVERLAPPING_POOLS'])
    expect(result).toMatchObject({ adaptiveFullBatches: 1, finalRemainderSize: 0 })
    expect(result.afterNormalInventory.size).toBe(59)
  })

  it('suppresses held, consumed and reserved IDs in both witness and remainder', () => {
    const a = group('a', 3)
    const b = group('b', 3)
    const s = group('s', 52, true)
    const i = group('i', 5, false, true)
    const [held, consumed, reserved] = s.slice(-3)
    const result = analyzeCycleCapacity(input([
      ...a, ...b, ...s.slice(0, 49), { ...held, held: true }, consumed, reserved, ...i,
    ], [family('a', a), family('b', b)], {
      consumedSourceIds: [consumed.sourceId],
      reservedSourceIds: [reserved.sourceId],
    }))
    witnessCheck(result, 1)
    if (!result.ok) throw new Error(result.reason)
    const used = result.witness[0].flatMap(({ questionIds }) => questionIds)
    expect([...used, ...result.anticipatedRemainder.sourceIds]).not.toContain(held.sourceId)
    expect([...used, ...result.anticipatedRemainder.sourceIds]).not.toContain(consumed.sourceId)
    expect([...used, ...result.anticipatedRemainder.sourceIds]).not.toContain(reserved.sourceId)
    expect(result.anticipatedRemainder.size).toBe(1)
  })

  it('passes stale versions and duplicate IDs through the same input guard as generation', () => {
    const q = question('dup', true, false)
    expect(analyzeCycleCapacity(input([q], [], { bankVersion: 'other-version' }))).toMatchObject({
      ok: false, reason: 'INVALID_BANK_VERSION',
    })
    expect(analyzeCycleCapacity(input([q, q], []))).toMatchObject({ ok: false, reason: 'DUPLICATE_SOURCE_ID' })
  })

  it('matches exhaustive role-flow enumeration on deterministic overlapping synthetic pools', () => {
    for (let seed = 0; seed < 24; seed += 1) {
      const chooser = (i: number) => (Math.imul(i + 13, 0x9e3779b1) ^ Math.imul(seed + 31, 0x85ebca6b)) >>> 0
      const families = Array.from({ length: 4 }, (_, f) => Array.from({ length: 3 + ((chooser(f) >>> 4) % 4) },
        (_, i) => question(`f${f}-${i}`, (chooser(f * 7 + i) & 4) === 0, (chooser(f * 7 + i) & 128) === 0)))
      const s = group('standard', seed % 2 === 0 ? 85 + seed : 30 + seed, true)
      const i = group('interactive', seed % 5, false, true)
      const shared = group('both', 5 + seed % 7, true, true)
      const qs = [...families.flat(), ...s, ...i, ...shared]
      const infos = families.map((members, f) => family('family-' + f, members))
      let exact = 0
      for (let batchCount = 1; batchCount <= Math.floor(qs.length / 59); batchCount += 1) {
        let feasible = false
        const vector = Array<number>(families.length).fill(0)
        const check = (position: number, needed: number) => {
          if (feasible || needed < 0) return
          if (position === families.length) {
            if (needed > 0) return
            feasible = allocateRoles([
              ...infos.map(({ id, childIds }, index) => ({ id, questionIds: childIds, quota: vector[index] * 3 })),
              { id: 'standard', quota: batchCount * 49, questionIds: qs.filter((q) => q.standardEligible).map((q) => q.sourceId) },
              { id: 'interactive', quota: batchCount * 4, questionIds: qs.filter((q) => q.interactiveEligible).map((q) => q.sourceId) },
            ]) !== null
            return
          }
          for (let n = 0; n <= Math.min(batchCount, Math.floor(families[position].length / 3)); n += 1) {
            vector[position] = n
            check(position + 1, needed - n)
          }
        }
        check(0, 2 * batchCount)
        if (feasible) exact = batchCount
      }
      witnessCheck(analyzeCycleCapacity(input(qs, infos)), exact)
    }
  })
})
