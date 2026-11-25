import { allocateRoles } from './batch-allocation'
import { generateBatch, prepareBatchInventory } from './batch-engine'
import type { BatchGenerationInput } from './batch-engine'
import { NORMAL_QUESTION_COUNT, NORMAL_SECTIONS } from './model'
import type { ExamSection, SourceQuestionId } from './model'

const [firstCase, secondCase, standard, interactive] = NORMAL_SECTIONS
const caseChildren = firstCase.count
const stableOrder = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

export type CycleCapacityInput = Pick<BatchGenerationInput, 'bank' | 'cycleState' | 'eligibilityPolicy'>
type Prepared = ReturnType<typeof prepareBatchInventory>
type Inventory = Extract<Prepared, { ok: true }>['inventory']
type Diagnostics = Prepared['diagnostics']
type InputFailure = Extract<Prepared, { ok: false }>['reason']

export type CapacityConstraint = 'CASE_STUDY' | 'STANDARD' | 'INTERACTIVE' | 'TOTAL_ELIGIBLE' | 'OVERLAPPING_POOLS'

export interface CycleCapacityBounds {
  readonly caseStudy: number
  readonly standard: number
  readonly interactive: number
  readonly totalEligible: number
}

export interface CapacityRemainderProjection {
  readonly size: number
  readonly sourceIds: readonly SourceQuestionId[]
}

export type CycleCapacityResult =
  | {
    readonly ok: true
    /** Compatibility alias for the maximum number of normal batches. */
    readonly maximumFullBatches: number
    readonly maximumNormalFullBatches: number
    readonly adaptiveFullBatches: number
    readonly finalRemainderSize: number
    readonly totalEligibleQuestions: number
    readonly limitingConstraints: readonly CapacityConstraint[]
    readonly independentBounds: CycleCapacityBounds
    /** Existence proof, not the order or choices promised by a seeded generator. */
    readonly witness: readonly (readonly ExamSection[])[]
    readonly adaptiveWitness: readonly (readonly ExamSection[])[]
    /** Inventory after normal batches, including future adaptives. */
    readonly afterNormalInventory: CapacityRemainderProjection
    /** Projected short final exam, not a guarantee of its identities for a different seed. */
    readonly anticipatedRemainder: CapacityRemainderProjection
    readonly diagnostics: Diagnostics
  }
  | {
    readonly ok: false
    readonly reason: InputFailure | 'CAPACITY_INVARIANT_VIOLATION'
    readonly diagnostics: Diagnostics
  }

interface IndexedFamily {
  readonly id: string
  readonly questionIds: readonly SourceQuestionId[]
  readonly appearances: number
  readonly outsideStandard: number
  readonly outsideInteractive: number
  readonly outsideEither: number
}

function indexInventory(inventory: Inventory) {
  const standardPool = new Set(inventory.standardIds)
  const interactivePool = new Set(inventory.interactiveIds)
  const globalUnion = new Set([...standardPool, ...interactivePool])
  const families: IndexedFamily[] = inventory.caseFamilies
    .filter((family) => family.questionIds.length >= caseChildren)
    .map(({ id, questionIds }) => ({
      id,
      questionIds: [...questionIds].sort(stableOrder),
      appearances: Math.floor(questionIds.length / caseChildren),
      outsideStandard: questionIds.filter((sourceId) => !standardPool.has(sourceId)).length,
      outsideInteractive: questionIds.filter((sourceId) => !interactivePool.has(sourceId)).length,
      outsideEither: questionIds.filter((sourceId) => !globalUnion.has(sourceId)).length,
    }))
    // Put less-contended cases first, then stabilise on identity.
    .sort((a, b) => (b.outsideEither - a.outsideEither) || stableOrder(a.id, b.id))
  return { families, standardPool, interactivePool, globalUnion }
}

function independentCaseBound(families: readonly IndexedFamily[]): number {
  let total = 0
  let largest = 0
  for (const family of families) {
    total += family.appearances
    largest = Math.max(largest, family.appearances)
  }
  // Every pair needs two appearances and at least one outside the largest family.
  return Math.min(Math.floor(total / 2), total - largest)
}

/**
 * A quota vector assigns 2k case appearances across distinct canonical families.
 * For a fixed vector, capacitated Hall feasibility is equivalent to four checks.
 * Choose a subset T of the two global roles, standard and interactive. Its pool
 * already covers some children of each family. Adding a family increases the
 * deficit by its quota less the number of children outside T's union. The worst
 * subset of families is therefore exactly the sum of positive such deficits.
 * Distinct canonical family pools make these increments additive. The empty
 * global subset is handled by the individual case-family capacity bound.
 */
function feasibleVector(
  batches: number,
  families: readonly IndexedFamily[],
  standardCount: number,
  interactiveCount: number,
  globalUnionCount: number,
): readonly number[] | null {
  const trackStandard = standardCount - standard.count * batches
  const trackInteractive = interactiveCount - interactive.count * batches
  const trackUnion = globalUnionCount - (standard.count + interactive.count) * batches
  if (trackStandard < 0 || trackInteractive < 0 || trackUnion < 0) return null

  const caps = families.map(({ appearances }) => Math.min(batches, appearances))
  const suffix = Array<number>(families.length + 1).fill(0)
  for (let index = families.length - 1; index >= 0; index -= 1) {
    suffix[index] = suffix[index + 1] + caps[index]
  }
  const chosen = Array<number>(families.length).fill(0)
  const dead = new Set<string>()
  // Prune on remaining slots, plus three monotone Hall deficits. No full-bank
  // scan or flow is performed for candidate vectors, successful or rejected.
  function search(index: number, needed: number, savedS: number, savedI: number, savedEither: number): boolean {
    if (needed < 0 || needed > suffix[index]) return false
    if (needed === 0) {
      chosen.fill(0, index)
      return true
    }
    if (index === families.length) return false
    const stateKey = `${index}:${needed}:${savedS}:${savedI}:${savedEither}`
    if (dead.has(stateKey)) return false
    const family = families[index]
    const lo = Math.max(0, needed - suffix[index + 1])
    const hi = Math.min(caps[index], needed)
    for (let uses = hi; uses >= lo; uses -= 1) {
      const quota = uses * caseChildren
      const afterS = savedS - Math.max(0, quota - family.outsideStandard)
      const afterI = savedI - Math.max(0, quota - family.outsideInteractive)
      const afterEither = savedEither - Math.max(0, quota - family.outsideEither)
      if (afterS < 0 || afterI < 0 || afterEither < 0) continue
      chosen[index] = uses
      if (search(index + 1, needed - uses, afterS, afterI, afterEither)) return true
    }
    dead.add(stateKey)
    return false
  }

  return search(0, 2 * batches, trackStandard, trackInteractive, trackUnion) ? chosen : null
}

function freezeSection(kind: ExamSection['kind'], questionIds: readonly SourceQuestionId[], caseStudyId?: string): ExamSection {
  return Object.freeze({
    kind,
    questionIds: Object.freeze([...questionIds]),
    ...(caseStudyId === undefined ? {} : { caseStudyId }),
  })
}

function materializeWitness(
  inventory: Inventory,
  families: readonly IndexedFamily[],
  batches: number,
  vector: readonly number[],
): readonly (readonly ExamSection[])[] | null {
  const byFamily = new Map(families.map((family) => [family.id, family]))
  const appearances = families.flatMap(({ id }, index) => Array<string>(vector[index]).fill(id)).sort(stableOrder)
  if (appearances.length !== 2 * batches) return null
  const activeFamilies = families.filter((_, index) => vector[index] > 0)
  const quotas = new Map(families.map((family, index) => [family.id, vector[index]]))
  const key = (familyId: string) => 'case:' + familyId
  const allocations = allocateRoles([
    ...activeFamilies.map(({ id, questionIds }) => ({ id: key(id), quota: (quotas.get(id) ?? 0) * caseChildren, questionIds })),
    { id: 'interactive', quota: batches * interactive.count, questionIds: [...inventory.interactiveIds].sort(stableOrder) },
    { id: 'standard', quota: batches * standard.count, questionIds: [...inventory.standardIds].sort(stableOrder) },
  ])
  if (!allocations) return null
  const std = allocations.get('standard')
  const int = allocations.get('interactive')
  if (!std || !int || std.length !== batches * standard.count || int.length !== batches * interactive.count) return null

  const next = new Map<string, number>()
  const used = new Set<SourceQuestionId>()
  const takeCase = (id: string) => {
    const offset = next.get(id) ?? 0
    next.set(id, offset + caseChildren)
    return allocations.get(key(id))?.slice(offset, offset + caseChildren)
  }
  const witness: (readonly ExamSection[])[] = []
  for (let index = 0; index < batches; index += 1) {
    // A sorted run has length at most k, so opposite halves (distance k) are
    // necessarily different. Consume each family's canonical allocation in 3s.
    const a = appearances[index]
    const b = appearances[index + batches]
    if (a === b || !byFamily.has(a) || !byFamily.has(b)) return null
    const qa = takeCase(a)
    const qb = takeCase(b)
    if (!qa || !qb || qa.length !== firstCase.count || qb.length !== secondCase.count) return null
    const sections = [
      freezeSection(firstCase.kind, qa, a),
      freezeSection(secondCase.kind, qb, b),
      freezeSection(standard.kind, std.slice(index * standard.count, (index + 1) * standard.count)),
      freezeSection(interactive.kind, int.slice(index * interactive.count, (index + 1) * interactive.count)),
    ]
    for (const section of sections) {
      for (const id of section.questionIds) {
        if (used.has(id)) return null
        used.add(id)
      }
    }
    witness.push(Object.freeze(sections))
  }
  return Object.freeze(witness)
}

function projection(ids: readonly SourceQuestionId[]): CapacityRemainderProjection {
  return Object.freeze({ sourceIds: Object.freeze([...ids]), size: ids.length })
}

/**
 * Exact maximum of pairwise disjoint normal batches under the generator's
 * prepared eligibility, not a forecast for any particular sequence of seeds.
 * Pool indexing is linear plus stable sorts. Count-vector search is bounded
 * by 2k family appearances at k <= floor(eligible/59); at small bank size it
 * prunes without rebuilding the question graph. One flow materializes a
 * witness. For pathological metadata with many families the vector search
 * remains combinatorial. The balance can be partitioned into adaptive full
 * batches and one short final exam without any remaining role quota.
 */
export function analyzeCycleCapacity(input: CycleCapacityInput): CycleCapacityResult {
  const prepared = prepareBatchInventory(input)
  if (!prepared.ok) {
    if (prepared.reason !== 'CYCLE_EXHAUSTED') return { ok: false, reason: prepared.reason, diagnostics: prepared.diagnostics }
    const empty = projection([])
    return Object.freeze({
      ok: true, maximumFullBatches: 0, maximumNormalFullBatches: 0, adaptiveFullBatches: 0, finalRemainderSize: 0,
      totalEligibleQuestions: 0, limitingConstraints: Object.freeze(['TOTAL_ELIGIBLE' as const]),
      independentBounds: Object.freeze({ caseStudy: 0, standard: 0, interactive: 0, totalEligible: 0 }),
      witness: Object.freeze([]), adaptiveWitness: Object.freeze([]), afterNormalInventory: empty,
      anticipatedRemainder: empty, diagnostics: prepared.diagnostics,
    })
  }
  const { inventory, diagnostics } = prepared
  const { families, standardPool, interactivePool, globalUnion } = indexInventory(inventory)
  const canonical = new Set<SourceQuestionId>()
  for (const family of families) {
    for (const id of family.questionIds) {
      if (canonical.has(id)) return { ok: false, reason: 'CAPACITY_INVARIANT_VIOLATION', diagnostics }
      canonical.add(id)
    }
  }
  const independentBounds: CycleCapacityBounds = Object.freeze({
    caseStudy: independentCaseBound(families),
    standard: Math.floor(standardPool.size / standard.count),
    interactive: Math.floor(interactivePool.size / interactive.count),
    totalEligible: Math.floor(inventory.eligibleQuestions.length / NORMAL_QUESTION_COUNT),
  })
  const upperBound = Math.min(...Object.values(independentBounds))
  let maximumFullBatches = upperBound
  let witness: readonly (readonly ExamSection[])[] = Object.freeze([])
  for (; maximumFullBatches > 0; maximumFullBatches -= 1) {
    const vector = feasibleVector(maximumFullBatches, families, standardPool.size, interactivePool.size, globalUnion.size)
    if (!vector) continue
    const allocated = materializeWitness(inventory, families, maximumFullBatches, vector)
    if (!allocated) return { ok: false, reason: 'CAPACITY_INVARIANT_VIOLATION', diagnostics }
    witness = allocated
    break
  }
  const bounds = [
    ['CASE_STUDY', independentBounds.caseStudy],
    ['STANDARD', independentBounds.standard],
    ['INTERACTIVE', independentBounds.interactive],
    ['TOTAL_ELIGIBLE', independentBounds.totalEligible],
  ] as const
  const limitingConstraints: CapacityConstraint[] = maximumFullBatches < upperBound
    ? ['OVERLAPPING_POOLS']
    : bounds.filter(([, count]) => count === maximumFullBatches).map(([role]) => role)
  const used = new Set(witness.flatMap((batch) => batch.flatMap((section) => section.questionIds)))
  const sourceIds = inventory.eligibleIds.filter((id) => !used.has(id))
  const adaptiveFullBatches = Math.floor(sourceIds.length / NORMAL_QUESTION_COUNT)
  const finalRemainderSize = sourceIds.length % NORMAL_QUESTION_COUNT
  const adaptiveWitness: (readonly ExamSection[])[] = []
  // Removing questions cannot re-create a normal assignment. Use the same
  // seeded allocator to provide a real partition instead of inventing IDs.
  for (let index = 0; index < adaptiveFullBatches; index += 1) {
    const plan = generateBatch({
      ...input, seed: 'capacity-adaptive-witness-v1',
      cycleState: { ...input.cycleState, consumedSourceIds: [...input.cycleState.consumedSourceIds, ...used] },
    })
    if (!plan.ok || plan.batch.kind !== 'ADAPTIVE_BATCH') {
      return { ok: false, reason: 'CAPACITY_INVARIANT_VIOLATION', diagnostics }
    }
    adaptiveWitness.push(plan.batch.sections)
    plan.batch.sourceIds.forEach((id) => used.add(id))
  }
  return Object.freeze({
    ok: true,
    maximumFullBatches,
    maximumNormalFullBatches: maximumFullBatches,
    adaptiveFullBatches,
    finalRemainderSize,
    totalEligibleQuestions: inventory.eligibleIds.length,
    limitingConstraints: Object.freeze(limitingConstraints),
    independentBounds,
    witness,
    adaptiveWitness: Object.freeze(adaptiveWitness),
    afterNormalInventory: projection(sourceIds),
    anticipatedRemainder: projection(sourceIds.filter((id) => !used.has(id))),
    diagnostics,
  })
}
