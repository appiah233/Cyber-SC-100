import { validateNormalBatch } from './attempt'
import type { EligibilityPolicy, GeneratedBatch } from './batch-engine'
import type { SourceQuestionId } from './model'

export type BatchStatus = 'GENERATED' | 'STARTED' | 'COMPLETED' | 'ABANDONED' | 'INVALIDATED'
export type CycleStatus = 'ACTIVE' | 'COMPLETE'
export type CycleCompatibility = 'COMPATIBLE' | 'MIGRATION_REQUIRED' | 'INCOMPATIBLE'
export type CycleCompletionReason = 'NO_ELIGIBLE_UNUSED_CONTENT' | 'FINAL_REMAINDER_RETIRED'

export interface TrackedBatch {
  readonly batch: GeneratedBatch
  readonly status: BatchStatus
  readonly generatedAt: number
  readonly startedAt: number | null
  readonly endedAt: number | null
}

export interface TrackedCycle {
  readonly id: string
  readonly cycleId: string
  readonly bankVersion: string
  readonly contentVersion: string
  readonly eligibilityPolicy: EligibilityPolicy
  readonly createdAt: number
  readonly status: CycleStatus
  readonly closedAt: number | null
  readonly completionReason: CycleCompletionReason | null
  readonly consumedSourceIds: readonly SourceQuestionId[]
  readonly reservedSourceIds: readonly SourceQuestionId[]
  readonly batches: readonly TrackedBatch[]
}

export interface CycleLifecycle {
  readonly id: string
  readonly revision: number
  readonly updatedAt: number
  readonly activeCycleId: string
  /** Oldest first; the selected cycle is always the final entry. */
  readonly cycles: readonly TrackedCycle[]
}

export interface NewCycleInput {
  readonly cycleId: string
  readonly bankVersion: string
  readonly eligibilityPolicy: EligibilityPolicy
  readonly createdAt: number
}

export type CycleLifecycleCommand =
  | { readonly type: 'GENERATE'; readonly batch: GeneratedBatch; readonly at: number }
  | { readonly type: 'START' | 'COMPLETE' | 'ABANDON' | 'INVALIDATE'; readonly batchId: string; readonly at: number }
  | { readonly type: 'COMPLETE_CYCLE'; readonly unusedEligibleSourceIds: readonly SourceQuestionId[]; readonly at: number }
  | {
    readonly type: 'START_NEW_CYCLE'
    readonly cycleId: string
    readonly bankVersion: string
    readonly eligibilityPolicy: EligibilityPolicy
    readonly at: number
  }

export type CycleLifecycleFailure =
  | 'INVALID_TIMESTAMP'
  | 'INVALID_COMMAND'
  | 'INVALID_LIFECYCLE'
  | 'INVALID_BATCH'
  | 'BATCH_ALREADY_EXISTS'
  | 'BATCH_NOT_FOUND'
  | 'CYCLE_COMPLETE'
  | 'CYCLE_NOT_COMPLETE'
  | 'CYCLE_ALREADY_EXISTS'
  | 'INVALID_CYCLE'
  | 'BANK_VERSION_MISMATCH'
  | 'ELIGIBILITY_POLICY_MISMATCH'
  | 'QUESTION_ALREADY_USED'
  | 'ACTIVE_BATCH_EXISTS'
  | 'INVALID_BATCH_TRANSITION'
  | 'ELIGIBLE_CONTENT_REMAINS'

export type CycleLifecycleResult =
  | { readonly ok: true; readonly state: CycleLifecycle }
  | { readonly ok: false; readonly reason: CycleLifecycleFailure }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) !== Array.prototype
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function policy(value: unknown): value is EligibilityPolicy {
  return value === 'DEVELOPMENT' || value === 'PRODUCTION'
}

function idList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || !Array.from(value).every(id)) return false
  return new Set(value).size === value.length
}

function sameSet(left: readonly string[], right: ReadonlySet<string>): boolean {
  return left.length === right.size && left.every((item) => right.has(item))
}

function immutable<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) immutable(child)
  return Object.freeze(value)
}

/** Avoid accepting exotic/non-JSON state in a persisted generated plan. */
function plainJson(value: unknown, ancestors = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (depth > 24 || (!record(value) && !Array.isArray(value)) || ancestors.has(value)) return false
  ancestors.add(value)
  const children = Array.isArray(value) ? Array.from(value) : Object.values(value)
  const valid = children.every((child) => plainJson(child, ancestors, depth + 1))
  ancestors.delete(value)
  return valid
}

const interactionKinds = new Set([
  'SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'DROPDOWN', 'DROPDOWN_HOTSPOT', 'STATEMENT',
  'MATCHING', 'DRAG_DROP', 'ORDERING', 'IMAGE_HOTSPOT', 'DIAGRAM_DEPENDENT',
])

const normalFailures = new Set([
  'CASE_STUDY_CHILDREN_EXHAUSTED', 'STANDARD_POOL_INSUFFICIENT', 'INTERACTIVE_POOL_EXHAUSTED',
  'MULTIPLE_CONSTRAINTS_EXHAUSTED', 'CROSS_SECTION_ALLOCATION_UNSATISFIABLE',
])

function validBatch(value: unknown): value is GeneratedBatch {
  if (!record(value) || !plainJson(value) || !id(value.id) || !id(value.cycleId)
    || !id(value.contentVersion) || !policy(value.eligibilityPolicy) || value.mode !== value.eligibilityPolicy
    || !idList(value.sourceIds)
    || value.sourceIds.length === 0 || value.total !== value.sourceIds.length
    || !((typeof value.seed === 'string' && value.seed.length > 0)
      || (typeof value.seed === 'number' && Number.isFinite(value.seed)))
    || !record(value.optionOrder) || !record(value.interactionKinds) || !Array.isArray(value.sections)) return false

  const source = new Set(value.sourceIds)
  if (!Object.entries(value.optionOrder).every(([key, order]) => source.has(key) && idList(order))) return false
  const interactions = Object.entries(value.interactionKinds)
  if (interactions.length !== source.size
    || !interactions.every(([key, kind]) => source.has(key) && typeof kind === 'string' && interactionKinds.has(kind))) return false
  const flattened: string[] = []
  for (const section of Array.from(value.sections)) {
    if (!record(section) || !idList(section.questionIds) || section.questionIds.length === 0) return false
    flattened.push(...section.questionIds)
  }
  if (flattened.length !== value.sourceIds.length
    || flattened.some((question, index) => question !== (value.sourceIds as readonly string[])[index])) return false

  if (value.kind === 'NORMAL_BATCH') return validateNormalBatch(value as unknown as GeneratedBatch & {
    readonly kind: 'NORMAL_BATCH'
  }).ok
  if (value.kind !== 'FINAL_REMAINDER_BATCH' || typeof value.normalFailure !== 'string'
    || !normalFailures.has(value.normalFailure)) return false

  const order: Record<string, number> = {
    REMAINDER_CASE_STUDY: 0,
    STANDARD_BLOCK: 1,
    REMAINDER_UNSECTIONED: 2,
    FINAL_INTERACTIVE_BLOCK: 3,
  }
  let previous = -1
  const cases = new Set<string>()
  for (const item of value.sections) {
    const section = item as Record<string, unknown>
    const kind = section.kind
    if (typeof kind !== 'string' || !Object.hasOwn(order, kind)
      || order[kind] < previous || (order[kind] === previous && kind !== 'REMAINDER_CASE_STUDY')) return false
    if (kind === 'REMAINDER_CASE_STUDY') {
      if (!id(section.caseStudyId) || cases.has(section.caseStudyId)) return false
      cases.add(section.caseStudyId)
    } else if (section.caseStudyId !== undefined) return false
    previous = order[kind]
  }
  return true
}

function readTrackedBatch(value: unknown, cycle: Record<string, unknown>): value is TrackedBatch {
  if (!record(value) || !validBatch(value.batch) || value.batch.cycleId !== cycle.id
    || value.batch.contentVersion !== cycle.bankVersion || value.batch.eligibilityPolicy !== cycle.eligibilityPolicy
    || !timestamp(value.generatedAt)
    || !timestamp(cycle.createdAt) || value.generatedAt < cycle.createdAt) return false
  const { status, startedAt, endedAt, generatedAt } = value
  if (startedAt !== null && (!timestamp(startedAt) || startedAt < generatedAt)) return false
  if (endedAt !== null && (!timestamp(endedAt) || endedAt < (startedAt ?? generatedAt))) return false
  switch (status) {
    case 'GENERATED': return startedAt === null && endedAt === null
    case 'STARTED': return startedAt !== null && endedAt === null
    case 'COMPLETED':
    case 'ABANDONED': return startedAt !== null && endedAt !== null
    case 'INVALIDATED': return endedAt !== null
    default: return false
  }
}

/** Reconcile stored sets to committed lifecycle records before accepting a reload. */
export function isCycleLifecycle(value: unknown): value is CycleLifecycle {
  if (!record(value) || !id(value.id) || !id(value.activeCycleId) || !timestamp(value.revision)
    || !timestamp(value.updatedAt) || !Array.isArray(value.cycles) || value.cycles.length === 0) return false

  const cycleIds = new Set<string>()
  let lastClosedAt = 0
  for (const [index, cycle] of Array.from(value.cycles).entries()) {
    if (!record(cycle) || !id(cycle.id) || cycleIds.has(cycle.id) || cycle.cycleId !== cycle.id
      || !id(cycle.bankVersion) || cycle.contentVersion !== cycle.bankVersion || !policy(cycle.eligibilityPolicy)
      || !timestamp(cycle.createdAt) || cycle.createdAt < lastClosedAt || cycle.createdAt > value.updatedAt
      || !idList(cycle.consumedSourceIds) || !idList(cycle.reservedSourceIds) || !Array.isArray(cycle.batches)) return false
    cycleIds.add(cycle.id)
    const selected = index === value.cycles.length - 1
    if (selected !== (cycle.id === value.activeCycleId)) return false
    if (cycle.status === 'COMPLETE') {
      if (!timestamp(cycle.closedAt) || cycle.closedAt < cycle.createdAt || cycle.closedAt > value.updatedAt
        || (cycle.completionReason !== 'NO_ELIGIBLE_UNUSED_CONTENT'
          && cycle.completionReason !== 'FINAL_REMAINDER_RETIRED')) return false
      lastClosedAt = cycle.closedAt
    } else if (cycle.status !== 'ACTIVE' || !selected || cycle.closedAt !== null || cycle.completionReason !== null) {
      return false
    }

    const batchIds = new Set<string>()
    const consumed = new Set<string>()
    const reserved = new Set<string>()
    const runs: { start: number; end: number }[] = []
    let started = 0
    let retiredRemainder = 0
    let previousGeneratedAt = cycle.createdAt
    for (const tracked of Array.from(cycle.batches)) {
      if (!readTrackedBatch(tracked, cycle) || batchIds.has(tracked.batch.id)
        || tracked.generatedAt < previousGeneratedAt
        || (tracked.endedAt ?? tracked.startedAt ?? tracked.generatedAt) > (cycle.closedAt ?? value.updatedAt)) return false
      previousGeneratedAt = tracked.generatedAt
      batchIds.add(tracked.batch.id)
      if (tracked.startedAt !== null) runs.push({ start: tracked.startedAt, end: tracked.endedAt ?? Infinity })
      if (tracked.status === 'STARTED') {
        started++
        for (const key of tracked.batch.sourceIds) reserved.add(key)
      } else if (tracked.startedAt !== null) {
        if (tracked.batch.kind === 'FINAL_REMAINDER_BATCH') {
          if (tracked.endedAt !== cycle.closedAt) return false
          retiredRemainder++
        }
        for (const key of tracked.batch.sourceIds) {
          if (consumed.has(key)) return false
          consumed.add(key)
        }
      }
      if (cycle.status === 'COMPLETE' && (tracked.status === 'STARTED' || tracked.status === 'GENERATED')) return false
    }
    runs.sort((a, b) => a.start - b.start || a.end - b.end)
    if (runs.some((run, index) => index > 0 && runs[index - 1].end > run.start)
      || started > 1 || [...reserved].some((key) => consumed.has(key))
      || (cycle.completionReason === 'FINAL_REMAINDER_RETIRED' ? retiredRemainder !== 1 : retiredRemainder !== 0)
      || !sameSet(cycle.consumedSourceIds, consumed) || !sameSet(cycle.reservedSourceIds, reserved)) return false
  }
  return true
}

function newCycle(input: NewCycleInput): TrackedCycle {
  return immutable({
    id: input.cycleId,
    cycleId: input.cycleId,
    bankVersion: input.bankVersion,
    contentVersion: input.bankVersion,
    eligibilityPolicy: input.eligibilityPolicy,
    createdAt: input.createdAt,
    status: 'ACTIVE',
    closedAt: null,
    completionReason: null,
    consumedSourceIds: [],
    reservedSourceIds: [],
    batches: [],
  } satisfies TrackedCycle)
}

function validNewCycle(input: NewCycleInput): boolean {
  return id(input.cycleId) && id(input.bankVersion) && policy(input.eligibilityPolicy) && timestamp(input.createdAt)
}

export function createCycleLifecycle(input: NewCycleInput & { readonly id: string }): CycleLifecycle {
  if (!id(input.id) || !validNewCycle(input)) throw new TypeError('Invalid cycle identity or pinned policy.')
  return immutable({
    id: input.id,
    revision: 0,
    updatedAt: input.createdAt,
    activeCycleId: input.cycleId,
    cycles: [newCycle(input)],
  })
}

export function activeExamCycle(state: CycleLifecycle): TrackedCycle {
  const cycle = state.cycles.at(-1)
  if (!cycle || cycle.id !== state.activeCycleId) throw new TypeError('Invalid active cycle.')
  return cycle
}

export function restoreCycleLifecycle(value: unknown): CycleLifecycle {
  if (!isCycleLifecycle(value)) throw new TypeError('Invalid saved cycle lifecycle.')
  return immutable(structuredClone(value))
}

export function cycleCompatibility(
  pinnedBankVersion: string,
  loadedBankVersion: string,
  pinnedBankAvailable = false,
): CycleCompatibility {
  if (!id(pinnedBankVersion) || !id(loadedBankVersion)) return 'INCOMPATIBLE'
  if (pinnedBankVersion === loadedBankVersion) return 'COMPATIBLE'
  return pinnedBankAvailable ? 'MIGRATION_REQUIRED' : 'INCOMPATIBLE'
}

function fail(reason: CycleLifecycleFailure): CycleLifecycleResult {
  return { ok: false, reason }
}

function update(state: CycleLifecycle, cycle: TrackedCycle, at: number, append = false): CycleLifecycleResult {
  const cycles = append ? [...state.cycles, cycle] : [...state.cycles.slice(0, -1), cycle]
  return {
    ok: true,
    state: immutable({
      ...state,
      cycles,
      updatedAt: at,
      activeCycleId: cycle.id,
      revision: state.revision + 1,
    }),
  }
}

function close(cycle: TrackedCycle, at: number, completionReason: CycleCompletionReason): TrackedCycle {
  return {
    ...cycle,
    status: 'COMPLETE',
    closedAt: at,
    completionReason,
    // Unstarted previews never reserve IDs and are discarded without consuming them.
    batches: cycle.batches.map((record) => record.status === 'GENERATED'
      ? { ...record, status: 'INVALIDATED', endedAt: at }
      : record),
  }
}

export function transitionCycleLifecycle(state: CycleLifecycle, command: CycleLifecycleCommand): CycleLifecycleResult {
  if (!isCycleLifecycle(state) || state.revision === Number.MAX_SAFE_INTEGER) return fail('INVALID_LIFECYCLE')
  if (!record(command)) return fail('INVALID_COMMAND')
  if (!timestamp(command.at) || command.at < state.updatedAt) return fail('INVALID_TIMESTAMP')
  const cycle = activeExamCycle(state)
  if (command.type === 'START_NEW_CYCLE') {
    if (cycle.status !== 'COMPLETE') return fail('CYCLE_NOT_COMPLETE')
    if (state.cycles.some((history) => history.id === command.cycleId)) return fail('CYCLE_ALREADY_EXISTS')
    const next = { ...command, createdAt: command.at }
    if (!validNewCycle(next)) return fail('INVALID_CYCLE')
    return update(state, newCycle(next), command.at, true)
  }

  if (cycle.status === 'COMPLETE') return fail('CYCLE_COMPLETE')
  const used = new Set([...cycle.consumedSourceIds, ...cycle.reservedSourceIds])
  if (command.type === 'GENERATE') {
    if (cycle.batches.some((tracked) => tracked.status === 'STARTED'
      && tracked.batch.kind === 'FINAL_REMAINDER_BATCH')) return fail('ACTIVE_BATCH_EXISTS')
    const candidate = command.batch
    if (!validBatch(candidate) || candidate.cycleId !== cycle.id) return fail('INVALID_BATCH')
    if (candidate.contentVersion !== cycle.bankVersion) return fail('BANK_VERSION_MISMATCH')
    if (candidate.eligibilityPolicy !== cycle.eligibilityPolicy) return fail('ELIGIBILITY_POLICY_MISMATCH')
    if (cycle.batches.some((tracked) => tracked.batch.id === candidate.id)) return fail('BATCH_ALREADY_EXISTS')
    if (candidate.sourceIds.some((key) => used.has(key))) return fail('QUESTION_ALREADY_USED')
    // A generated preview snapshots exact membership; it neither reserves nor consumes.
    const tracked: TrackedBatch = {
      batch: structuredClone(candidate),
      status: 'GENERATED',
      generatedAt: command.at,
      startedAt: null,
      endedAt: null,
    }
    return update(state, { ...cycle, batches: [...cycle.batches, tracked] }, command.at)
  }
  if (command.type === 'COMPLETE_CYCLE') {
    if (cycle.batches.some((tracked) => tracked.status === 'STARTED')) return fail('ACTIVE_BATCH_EXISTS')
    if (!idList(command.unusedEligibleSourceIds) || command.unusedEligibleSourceIds.length !== 0
      || cycle.batches.some((tracked) => tracked.status === 'GENERATED'
        && tracked.batch.sourceIds.some((key) => !used.has(key)))) {
      return fail('ELIGIBLE_CONTENT_REMAINS')
    }
    return update(state, close(cycle, command.at, 'NO_ELIGIBLE_UNUSED_CONTENT'), command.at)
  }

  if (command.type !== 'START' && command.type !== 'COMPLETE'
    && command.type !== 'ABANDON' && command.type !== 'INVALIDATE') return fail('INVALID_COMMAND')
  const index = cycle.batches.findIndex((tracked) => tracked.batch.id === command.batchId)
  const tracked = cycle.batches[index]
  if (!tracked) return fail('BATCH_NOT_FOUND')
  const replace = (next: TrackedBatch) => cycle.batches.map((item, position) => position === index ? next : item)
  if (command.type === 'START') {
    if (tracked.status !== 'GENERATED') return fail('INVALID_BATCH_TRANSITION')
    if (cycle.batches.some((item) => item.status === 'STARTED')) return fail('ACTIVE_BATCH_EXISTS')
    if (tracked.batch.sourceIds.some((key) => used.has(key))) return fail('QUESTION_ALREADY_USED')
    const batches = replace({ ...tracked, status: 'STARTED', startedAt: command.at })
    return update(state, { ...cycle, batches, reservedSourceIds: [...tracked.batch.sourceIds] }, command.at)
  }

  if (command.type === 'INVALIDATE' && tracked.status === 'GENERATED') {
    const batches = replace({ ...tracked, status: 'INVALIDATED', endedAt: command.at })
    return update(state, { ...cycle, batches }, command.at)
  }
  if (tracked.status !== 'STARTED') return fail('INVALID_BATCH_TRANSITION')
  const status = command.type === 'COMPLETE' ? 'COMPLETED'
    : command.type === 'ABANDON' ? 'ABANDONED' : 'INVALIDATED'
  const batches = replace({ ...tracked, status, endedAt: command.at })
  // Every started batch exposed membership. Retire its questions even on abandonment
  // or invalidation, rather than allowing a same-cycle replay.
  const next: TrackedCycle = {
    ...cycle,
    batches,
    reservedSourceIds: [],
    consumedSourceIds: [...cycle.consumedSourceIds, ...tracked.batch.sourceIds],
  }
  return update(
    state,
    tracked.batch.kind === 'FINAL_REMAINDER_BATCH' ? close(next, command.at, 'FINAL_REMAINDER_RETIRED') : next,
    command.at,
  )
}
