import { allocateRoles } from './batch-allocation'
import { NORMAL_SECTIONS } from './model'
import type { ExamBatch, ExamSection, QuestionInteraction, Seed } from './model'
import { seededQuestionOrder } from './random'

export type EligibilityPolicy = 'DEVELOPMENT' | 'PRODUCTION'
type InteractionKind = QuestionInteraction['kind']

export interface BatchOptionGroup {
  readonly id: string
  readonly optionIds: readonly string[]
  /** Only reviewed display order is randomized; response identities are unchanged. */
  readonly shuffle: boolean
}

export interface BatchQuestion {
  readonly sourceId: string
  readonly interactionKind: InteractionKind
  readonly developmentValidated: boolean
  readonly productionEligible: boolean
  readonly held?: boolean
  readonly standardEligible: boolean
  readonly interactiveEligible?: boolean
  readonly optionGroups?: readonly BatchOptionGroup[]
}

export interface BatchCaseFamily {
  readonly id: string
  readonly childIds: readonly string[]
  readonly developmentValidated: boolean
  readonly productionEligible: boolean
}

export interface BatchBank {
  readonly version: string
  readonly questions: readonly BatchQuestion[]
  readonly caseStudies: readonly BatchCaseFamily[]
}

export interface BatchCycleState {
  readonly cycleId: string
  readonly bankVersion: string
  readonly consumedSourceIds: readonly string[]
  readonly reservedSourceIds: readonly string[]
  readonly status?: 'ACTIVE' | 'COMPLETE'
}

export interface BatchGenerationInput {
  readonly bank: BatchBank
  readonly cycleState: BatchCycleState
  readonly eligibilityPolicy: EligibilityPolicy
  readonly seed: Seed
}

export type NormalBatchFailure =
  | 'CASE_STUDY_CHILDREN_EXHAUSTED'
  | 'STANDARD_POOL_INSUFFICIENT'
  | 'INTERACTIVE_POOL_EXHAUSTED'
  | 'MULTIPLE_CONSTRAINTS_EXHAUSTED'
  | 'CROSS_SECTION_ALLOCATION_UNSATISFIABLE'

export type BatchGenerationFailure =
  | NormalBatchFailure
  | 'INVALID_BANK_VERSION'
  | 'INVALID_BANK'
  | 'DUPLICATE_SOURCE_ID'
  | 'INVALID_CYCLE_STATE'
  | 'INVALID_INPUT'
  | 'CYCLE_COMPLETE'
  | 'CYCLE_EXHAUSTED'
  | 'INSUFFICIENT_PRODUCTION_CONTENT'

export interface BatchDiagnostics {
  readonly eligibleUnusedQuestions: number
  readonly eligibleUnusedCaseFamilies: number
  readonly caseFamiliesWithThreeChildren: number
  readonly eligibleUnusedCaseChildren: number
  readonly eligibleUnusedStandardQuestions: number
  readonly eligibleUnusedInteractiveQuestions: number
  readonly excludedReviewStatus: number
  readonly excludedConsumed: number
  readonly excludedReserved: number
  readonly excludedProductionIneligible: number
  readonly eligibleUnsectionedQuestions: number
  readonly normalFailure: NormalBatchFailure | null
  readonly constraints: readonly NormalBatchFailure[]
}

export interface PreparedBatchInventory {
  readonly eligibleQuestions: readonly BatchQuestion[]
  readonly eligibleIds: readonly string[]
  readonly standardIds: readonly string[]
  readonly interactiveIds: readonly string[]
  readonly caseFamilies: readonly { readonly id: string; readonly questionIds: readonly string[] }[]
}

export type PreparedInventoryResult =
  | { readonly ok: true; readonly inventory: PreparedBatchInventory; readonly diagnostics: BatchDiagnostics }
  | { readonly ok: false; readonly reason: BatchGenerationFailure; readonly diagnostics: BatchDiagnostics }

interface GeneratedMetadata {
  readonly cycleId: string
  readonly eligibilityPolicy: EligibilityPolicy
  readonly total: number
  readonly sourceIds: readonly string[]
  readonly optionOrder: Readonly<Record<string, readonly string[]>>
  readonly interactionKinds: Readonly<Record<string, InteractionKind>>
}

export interface GeneratedNormalBatch extends ExamBatch, GeneratedMetadata {
  readonly kind: 'NORMAL_BATCH'
  readonly mode: EligibilityPolicy
}

export interface RemainderSection {
  readonly kind: 'REMAINDER_CASE_STUDY' | 'STANDARD_BLOCK' | 'FINAL_INTERACTIVE_BLOCK' | 'REMAINDER_UNSECTIONED'
  readonly questionIds: readonly string[]
  readonly caseStudyId?: string
}

export interface GeneratedRemainderBatch extends GeneratedMetadata {
  readonly kind: 'FINAL_REMAINDER_BATCH'
  readonly id: string
  readonly contentVersion: string
  readonly seed: Seed
  readonly mode: EligibilityPolicy
  readonly sections: readonly RemainderSection[]
  readonly normalFailure: NormalBatchFailure
}

export type GeneratedBatch = GeneratedNormalBatch | GeneratedRemainderBatch
export type BatchGenerationResult =
  | { readonly ok: true; readonly batch: GeneratedBatch; readonly diagnostics: BatchDiagnostics }
  | { readonly ok: false; readonly reason: BatchGenerationFailure; readonly diagnostics: BatchDiagnostics }

export const INTERACTIVE_PRIORITY = Object.freeze([
  'IMAGE_HOTSPOT',
  'DROPDOWN_HOTSPOT',
  'DIAGRAM_DEPENDENT',
  'DRAG_DROP',
  'MATCHING',
  'ORDERING',
  'STATEMENT',
] as const satisfies readonly InteractionKind[])

const interactiveRank = new Map<InteractionKind, number>(INTERACTIVE_PRIORITY.map((kind, index) => [kind, index]))
const knownKinds = new Set<InteractionKind>([...INTERACTIVE_PRIORITY, 'SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'DROPDOWN'])
const CASE_COUNT = NORMAL_SECTIONS[0]!.count
const STANDARD_COUNT = NORMAL_SECTIONS[2]!.count
const INTERACTIVE_COUNT = NORMAL_SECTIONS[3]!.count

const emptyDiagnostics: BatchDiagnostics = Object.freeze({
  eligibleUnusedQuestions: 0,
  eligibleUnusedCaseFamilies: 0,
  caseFamiliesWithThreeChildren: 0,
  eligibleUnusedCaseChildren: 0,
  eligibleUnusedStandardQuestions: 0,
  eligibleUnusedInteractiveQuestions: 0,
  excludedReviewStatus: 0,
  excludedConsumed: 0,
  excludedReserved: 0,
  excludedProductionIneligible: 0,
  eligibleUnsectionedQuestions: 0,
  normalFailure: null,
  constraints: Object.freeze([]),
})

function fail(reason: BatchGenerationFailure, diagnostics = emptyDiagnostics): Extract<BatchGenerationResult, { ok: false }> {
  return { ok: false, reason, diagnostics }
}

function key(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function flags(record: BatchQuestion | BatchCaseFamily) {
  return typeof record.developmentValidated === 'boolean' && typeof record.productionEligible === 'boolean'
}

function idList(values: unknown): values is readonly string[] {
  return Array.isArray(values) && Array.from(values).every(key) && new Set(values).size === values.length
}

function validOptionGroups(groups: BatchQuestion['optionGroups']): boolean {
  if (groups === undefined) return true
  if (!Array.isArray(groups)) return false
  const groupIds = new Set<string>()
  const optionIds = new Set<string>()
  for (const group of groups) {
    if (!group || !key(group.id) || groupIds.has(group.id) || !idList(group.optionIds)
      || group.optionIds.length === 0 || typeof group.shuffle !== 'boolean') return false
    groupIds.add(group.id)
    for (const id of group.optionIds) {
      if (optionIds.has(id)) return false
      optionIds.add(id)
    }
  }
  return true
}

function allowed(profile: EligibilityPolicy, record: BatchQuestion | BatchCaseFamily): boolean {
  return profile === 'PRODUCTION' ? record.productionEligible === true : record.developmentValidated === true
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function prepareBatchInventory(
  input: Pick<BatchGenerationInput, 'bank' | 'cycleState' | 'eligibilityPolicy'>,
): PreparedInventoryResult {
  const { bank, cycleState, eligibilityPolicy } = input
  if (!bank || !cycleState || !key(bank.version) || !key(cycleState.bankVersion)
    || bank.version !== cycleState.bankVersion) return fail('INVALID_BANK_VERSION')
  if (eligibilityPolicy !== 'DEVELOPMENT' && eligibilityPolicy !== 'PRODUCTION') return fail('INVALID_INPUT')
  if (!key(cycleState.cycleId) || !idList(cycleState.consumedSourceIds) || !idList(cycleState.reservedSourceIds)
    || (cycleState.status !== undefined && cycleState.status !== 'ACTIVE' && cycleState.status !== 'COMPLETE')) {
    return fail('INVALID_CYCLE_STATE')
  }
  if (!Array.isArray(bank.questions) || !Array.isArray(bank.caseStudies)) return fail('INVALID_BANK')

  const byId = new Map<string, BatchQuestion>()
  for (const question of bank.questions as readonly BatchQuestion[]) {
    if (!question || !key(question.sourceId) || !knownKinds.has(question.interactionKind)
      || !flags(question) || typeof question.standardEligible !== 'boolean'
      || (question.held !== undefined && typeof question.held !== 'boolean')
      || (question.interactiveEligible !== undefined && typeof question.interactiveEligible !== 'boolean')
      || (question.interactiveEligible === true && !interactiveRank.has(question.interactionKind))
      || !validOptionGroups(question.optionGroups)) return fail('INVALID_BANK')
    if (byId.has(question.sourceId)) return fail('DUPLICATE_SOURCE_ID')
    byId.set(question.sourceId, question)
  }

  const familyIds = new Set<string>()
  const caseChildIds = new Set<string>()
  for (const family of bank.caseStudies as readonly BatchCaseFamily[]) {
    if (!family || !key(family.id) || familyIds.has(family.id) || !flags(family) || !idList(family.childIds)) {
      return fail('INVALID_BANK')
    }
    familyIds.add(family.id)
    // The reviewed bank gives each child a single canonical scenario; competing
    // scenario assignments would make its provenance and remainder ambiguous.
    for (const child of family.childIds) {
      if (!byId.has(child) || caseChildIds.has(child)) return fail('INVALID_BANK')
      caseChildIds.add(child)
    }
  }

  const consumed = new Set(cycleState.consumedSourceIds)
  const reserved = new Set(cycleState.reservedSourceIds)
  if ([...consumed].some((id) => !byId.has(id) || reserved.has(id))
    || [...reserved].some((id) => !byId.has(id))
    || (cycleState.status === 'COMPLETE' && reserved.size > 0)) return fail('INVALID_CYCLE_STATE')

  const eligibleQuestions: BatchQuestion[] = []
  let excludedReviewStatus = 0
  let excludedProductionIneligible = 0
  let qualifiedBeforeUsage = 0
  for (const question of byId.values()) {
    if (question.held === true || (eligibilityPolicy === 'DEVELOPMENT' && !question.developmentValidated)) {
      excludedReviewStatus += 1
    }
    if (eligibilityPolicy === 'PRODUCTION' && !question.productionEligible) excludedProductionIneligible += 1
    if (question.held === true || !allowed(eligibilityPolicy, question)) continue
    qualifiedBeforeUsage += 1
    if (!consumed.has(question.sourceId) && !reserved.has(question.sourceId)) eligibleQuestions.push(question)
  }
  eligibleQuestions.sort((left, right) => compare(left.sourceId, right.sourceId))
  const eligibleIds = new Set(eligibleQuestions.map(({ sourceId }) => sourceId))
  const standardIds = eligibleQuestions.filter((question) => question.standardEligible).map(({ sourceId }) => sourceId)
  const interactiveIds = eligibleQuestions.filter((question) => question.interactiveEligible === true)
    .map(({ sourceId }) => sourceId)
  const caseFamilies = (bank.caseStudies as readonly BatchCaseFamily[])
    .filter((family) => allowed(eligibilityPolicy, family))
    .map(({ id, childIds }) => ({ id, questionIds: childIds.filter((child) => eligibleIds.has(child)).sort(compare) }))
    .filter(({ questionIds }) => questionIds.length > 0)
    .sort((left, right) => compare(left.id, right.id))
  const familyChildren = caseFamilies.flatMap(({ questionIds }) => questionIds)
  const sectioned = new Set([...standardIds, ...interactiveIds, ...familyChildren])
  const diagnostics: BatchDiagnostics = Object.freeze({
    ...emptyDiagnostics,
    eligibleUnusedQuestions: eligibleQuestions.length,
    eligibleUnusedCaseFamilies: caseFamilies.length,
    caseFamiliesWithThreeChildren: caseFamilies.filter(({ questionIds }) => questionIds.length >= CASE_COUNT).length,
    eligibleUnusedCaseChildren: familyChildren.length,
    eligibleUnusedStandardQuestions: standardIds.length,
    eligibleUnusedInteractiveQuestions: interactiveIds.length,
    excludedReviewStatus,
    excludedConsumed: consumed.size,
    excludedReserved: reserved.size,
    excludedProductionIneligible,
    eligibleUnsectionedQuestions: eligibleQuestions.length - sectioned.size,
  })
  if (cycleState.status === 'COMPLETE') return fail('CYCLE_COMPLETE', diagnostics)
  if (eligibilityPolicy === 'PRODUCTION' && qualifiedBeforeUsage === 0) {
    return fail('INSUFFICIENT_PRODUCTION_CONTENT', diagnostics)
  }
  if (eligibleQuestions.length === 0) return fail('CYCLE_EXHAUSTED', diagnostics)
  return { ok: true, diagnostics, inventory: { eligibleQuestions, eligibleIds: Object.freeze([...eligibleIds]), standardIds, interactiveIds, caseFamilies } }
}

interface Ranking {
  readonly families: PreparedBatchInventory['caseFamilies']
  readonly children: ReadonlyMap<string, readonly string[]>
  readonly standardIds: readonly string[]
  readonly interactiveIds: readonly string[]
  readonly interactiveCosts: ReadonlyMap<string, number>
}

function rankedInventory(input: BatchGenerationInput, inventory: PreparedBatchInventory): Ranking {
  const shuffle = (ids: readonly string[], scope: string) => seededQuestionOrder(ids, input.seed, input.bank.version, scope)
  const byId = new Map(inventory.eligibleQuestions.map((question) => [question.sourceId, question]))
  const byFamily = new Map(inventory.caseFamilies.map((family) => [family.id, family]))
  const families = shuffle([...byFamily.keys()], 'batch:families').map((id) => byFamily.get(id)!)
  const children = new Map(families.map(({ id, questionIds }) => [id, shuffle(questionIds, `batch:case:${id}`)]))
  const interactiveIds = [...shuffle(inventory.interactiveIds, 'batch:interactive')]
    .sort((a, b) => interactiveRank.get(byId.get(a)!.interactionKind)! - interactiveRank.get(byId.get(b)!.interactionKind)!)
  // Every higher tier outranks four picks across all lower tiers. Exact min-cost
  // matching can then enforce the policy even if role pools overlap.
  const base = INTERACTIVE_COUNT + 1
  const top = base ** (INTERACTIVE_PRIORITY.length - 1)
  const interactiveCosts = new Map(interactiveIds.map((id) => [
    id, top - base ** (INTERACTIVE_PRIORITY.length - 1 - interactiveRank.get(byId.get(id)!.interactionKind)!),
  ]))
  return {
    families,
    children,
    standardIds: shuffle(inventory.standardIds, 'batch:standard'),
    interactiveIds,
    interactiveCosts,
  }
}

function normalSections(ranking: Ranking): readonly ExamSection[] | null {
  const families = ranking.families.filter(({ questionIds }) => questionIds.length >= CASE_COUNT)
  const costBound = ranking.interactiveIds.slice(0, INTERACTIVE_COUNT)
    .reduce((sum, id) => sum + ranking.interactiveCosts.get(id)!, 0)
  let lowest = Infinity
  let best: readonly ExamSection[] | null = null
  for (const [index, first] of families.entries()) {
    for (const second of families.slice(index + 1)) {
      const result = allocateRoles([
        { id: 'interaction', quota: INTERACTIVE_COUNT, questionIds: ranking.interactiveIds, costByQuestion: ranking.interactiveCosts },
        { id: 'case1', quota: CASE_COUNT, questionIds: ranking.children.get(first.id)! },
        { id: 'case2', quota: CASE_COUNT, questionIds: ranking.children.get(second.id)! },
        { id: 'standard', quota: STANDARD_COUNT, questionIds: ranking.standardIds },
      ])
      if (!result) continue
      const interactive = result.get('interaction')!
      const cost = interactive.reduce((sum, id) => sum + ranking.interactiveCosts.get(id)!, 0)
      if (cost < lowest) {
        lowest = cost
        best = [
          { kind: 'CASE_STUDY_1', caseStudyId: first.id, questionIds: result.get('case1')! },
          { kind: 'CASE_STUDY_2', caseStudyId: second.id, questionIds: result.get('case2')! },
          { kind: 'STANDARD_BLOCK', questionIds: result.get('standard')! },
          { kind: 'FINAL_INTERACTIVE_BLOCK', questionIds: interactive },
        ]
        if (cost === costBound) return best
      }
    }
  }
  return best
}

function rawShortages(diagnostics: BatchDiagnostics): NormalBatchFailure[] {
  const constraints: NormalBatchFailure[] = []
  if (diagnostics.caseFamiliesWithThreeChildren < 2) constraints.push('CASE_STUDY_CHILDREN_EXHAUSTED')
  if (diagnostics.eligibleUnusedStandardQuestions < STANDARD_COUNT) constraints.push('STANDARD_POOL_INSUFFICIENT')
  if (diagnostics.eligibleUnusedInteractiveQuestions < INTERACTIVE_COUNT) constraints.push('INTERACTIVE_POOL_EXHAUSTED')
  return constraints
}

function remainderSections(
  input: BatchGenerationInput,
  inventory: PreparedBatchInventory,
  ranking: Ranking,
): readonly RemainderSection[] {
  const placed = new Set<string>()
  function consume(pool: readonly string[]): readonly string[] {
    return pool.filter((id) => {
      if (placed.has(id)) return false
      placed.add(id)
      return true
    })
  }
  const groups: RemainderSection[] = ranking.families.map(({ id }) => ({
    kind: 'REMAINDER_CASE_STUDY', caseStudyId: id, questionIds: consume(ranking.children.get(id)!),
  }))
  // A reviewed scenario remains intact. When an independent question can fill
  // both roles, preserve its interactive presentation in the last section.
  const interactive = consume(ranking.interactiveIds)
  const standard = consume(ranking.standardIds)
  const unsectioned = consume(seededQuestionOrder(
    inventory.eligibleQuestions.map(({ sourceId }) => sourceId), input.seed, input.bank.version, 'batch:remainder',
  ))
  return [
    ...groups,
    { kind: 'STANDARD_BLOCK' as const, questionIds: standard },
    { kind: 'REMAINDER_UNSECTIONED' as const, questionIds: unsectioned },
    { kind: 'FINAL_INTERACTIVE_BLOCK' as const, questionIds: interactive },
  ].filter(({ questionIds }) => questionIds.length > 0)
}

function snapshotSections<T extends ExamSection | RemainderSection>(sections: readonly T[]): readonly T[] {
  return Object.freeze(sections.map((section) => {
    const copied: T = { ...section, questionIds: Object.freeze([...section.questionIds]) }
    Object.freeze(copied)
    return copied
  }))
}

/** Stable local identity, not a verifier or a secrecy/authentication primitive. */
function batchIdentifier(parts: readonly unknown[]): string {
  let hash = 0xcbf29ce484222325n
  const text = JSON.stringify(parts)
  for (let i = 0; i < text.length; i += 1) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n)
  }
  return `batch-${hash.toString(16).padStart(16, '0')}`
}

function generatedFields(
  input: BatchGenerationInput,
  inventory: PreparedBatchInventory,
  sections: readonly (ExamSection | RemainderSection)[],
): GeneratedMetadata & Pick<ExamBatch, 'id' | 'contentVersion' | 'seed'> & { readonly mode: EligibilityPolicy } {
  const byId = new Map(inventory.eligibleQuestions.map((question) => [question.sourceId, question]))
  const sourceIds = Object.freeze(sections.flatMap(({ questionIds }) => questionIds))
  const optionOrder = Object.freeze(Object.fromEntries(sourceIds.flatMap((id) => {
    const groups = byId.get(id)!.optionGroups
    if (!groups?.length) return []
    return [[id, Object.freeze(groups.flatMap((group) => group.shuffle
      ? seededQuestionOrder(group.optionIds, input.seed, input.bank.version, `batch:option:${id}:${group.id}`)
      : [...group.optionIds]))]]
  })))
  const interactionKinds = Object.freeze(Object.fromEntries(sourceIds.map((id) => [id, byId.get(id)!.interactionKind])))
  const id = batchIdentifier([
    input.cycleState.cycleId, input.bank.version, input.eligibilityPolicy, input.seed, sections, optionOrder, interactionKinds,
  ])
  return {
    id,
    contentVersion: input.bank.version,
    seed: input.seed,
    mode: input.eligibilityPolicy,
    cycleId: input.cycleState.cycleId,
    eligibilityPolicy: input.eligibilityPolicy,
    total: sourceIds.length,
    sourceIds,
    optionOrder,
    interactionKinds,
  }
}

/**
 * Preserve the exact order of an independently pinned development reference.
 * Normal generation remains the authority for capacity. This path cannot
 * expose other eligible IDs, reserve anything, or be used in production.
 */
export function generateExactDevelopmentBatch(
  input: BatchGenerationInput,
  exact: readonly ExamSection[],
): BatchGenerationResult {
  if (input.eligibilityPolicy !== 'DEVELOPMENT') return fail('INSUFFICIENT_PRODUCTION_CONTENT')
  const generated = generateBatch(input)
  if (!generated.ok) return generated
  if (generated.batch.kind !== 'NORMAL_BATCH') return fail('INVALID_INPUT', generated.diagnostics)
  const prepared = prepareBatchInventory(input)
  if (!prepared.ok) return prepared
  const { inventory, diagnostics } = prepared
  const ids = exact.flatMap(section => section.questionIds)
  const families = new Map(inventory.caseFamilies.map(family => [family.id, new Set(family.questionIds)]))
  const standards = new Set(inventory.standardIds)
  const interactions = new Set(inventory.interactiveIds)
  if (exact.length !== NORMAL_SECTIONS.length || ids.length !== inventory.eligibleIds.length
    || new Set(ids).size !== ids.length
    || exact[0]?.caseStudyId === exact[1]?.caseStudyId
    || exact.some((section, index) => {
      const shape = NORMAL_SECTIONS[index]!
      if (section.kind !== shape.kind || section.questionIds.length !== shape.count) return true
      if (index < 2) {
        const children = families.get(section.caseStudyId ?? '')
        return !children || !section.questionIds.every(id => children.has(id))
      }
      const pool = index === 2 ? standards : interactions
      return section.caseStudyId !== undefined || !section.questionIds.every(id => pool.has(id))
    })) return fail('INVALID_INPUT', diagnostics)
  const sections = snapshotSections(exact)
  const batch: GeneratedNormalBatch = Object.freeze({
    kind: 'NORMAL_BATCH', ...generatedFields(input, inventory, sections), sections,
  })
  return { ok: true, batch, diagnostics }
}

export function generateBatch(input: BatchGenerationInput): BatchGenerationResult {
  if (!((typeof input.seed === 'string' && input.seed.length > 0)
    || (typeof input.seed === 'number' && Number.isFinite(input.seed)))) return fail('INVALID_INPUT')
  const prepared = prepareBatchInventory(input)
  if (!prepared.ok) return prepared
  const { inventory, diagnostics } = prepared
  const ranked = rankedInventory(input, inventory)
  const shortages = rawShortages(diagnostics)
  if (shortages.length === 0) {
    const assignment = normalSections(ranked)
    if (assignment) {
      const sections = snapshotSections(assignment)
      const batch: GeneratedNormalBatch = Object.freeze({
        kind: 'NORMAL_BATCH',
        ...generatedFields(input, inventory, sections),
        sections,
      })
      return { ok: true, batch, diagnostics }
    }
  }
  const constraints = Object.freeze(shortages.length > 0 ? shortages : ['CROSS_SECTION_ALLOCATION_UNSATISFIABLE' as const])
  const normalFailure = constraints.length > 1 ? 'MULTIPLE_CONSTRAINTS_EXHAUSTED' : constraints[0]!
  const sections = snapshotSections(remainderSections(input, inventory, ranked))
  const batch: GeneratedRemainderBatch = Object.freeze({
    kind: 'FINAL_REMAINDER_BATCH', ...generatedFields(input, inventory, sections), sections, normalFailure,
  })
  return {
    ok: true,
    batch,
    diagnostics: Object.freeze({ ...diagnostics, constraints, normalFailure }),
  }
}
