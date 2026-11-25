import { prepareBatchInventory } from '../domain/batch-engine'
import type { BatchBank, EligibilityPolicy, GeneratedBatch } from '../domain/batch-engine'
import { generateCycleBatch } from '../domain/cycle-plan'
import { activeExamCycle, isCycleLifecycle, transitionCycleLifecycle } from '../domain/cycle-lifecycle'
import type { CycleLifecycle, TrackedCycle } from '../domain/cycle-lifecycle'
import { StorageError } from '../storage'
import type { SavedExam } from '../storage'
import { isTerminalAttempt, newCandidateAttempt } from './candidate-attempt'
import type { CandidateCycle, CandidateSnapshot, FoundationSource } from './candidate-attempt'

export type JourneyAdvance = 'NEXT_EXAM' | 'START_NEW_CYCLE'
type SavedCandidate = SavedExam<CandidateSnapshot, CandidateCycle>
export interface JourneyControls {
  readonly id: string
  readonly advance: (record: SavedCandidate, action: JourneyAdvance, at: number) => NextCandidate
  readonly onAdvanced: () => void
  readonly onStale: () => void
}
export interface CandidateJourneyOptions {
  readonly id: string
  readonly idbName: string
  readonly bank: BatchBank
  readonly eligibilityPolicy: EligibilityPolicy
  readonly sourceFor: (batch: GeneratedBatch) => Omit<FoundationSource, 'attemptId' | 'batch' | 'idbName' | 'eligibleSourceIds' | 'journey' | 'focusOnMount'>
}
interface NextCandidate {
  readonly attempt: CandidateSnapshot
  readonly cycle: CandidateCycle
  readonly source: FoundationSource
}

export function canAdvanceCandidate(attempt: CandidateSnapshot, requireScore: boolean) {
  return isTerminalAttempt(attempt) && (!requireScore || attempt.status === 'SCORED')
}

export function candidateCycleSummary(record: SavedCandidate, inventory: readonly string[]) {
  const active = activeExamCycle(record.cycle.lifecycle)
  return {
    status: active.status,
    examNumber: active.batches.findIndex(({ batch }) => batch.id === record.attempt.batch.id) + 1,
    availableQuestions: inventory.length - active.consumedSourceIds.length,
    consumedQuestions: active.consumedSourceIds.length,
    totalQuestions: inventory.length,
  }
}

/** Bind all candidate batches to the same validated eligibility universe.
 * The first seed and cycle id are deterministic across open tabs; nothing
 * is exposed as editable until the corresponding IndexedDB write commits. */
export function createCandidateJourney(options: CandidateJourneyOptions) {
  const { id, idbName, bank, eligibilityPolicy, sourceFor } = options
  if (!id || id.trim() !== id || !idbName || idbName.trim() !== idbName) throw new StorageError('CORRUPT')
  const cycleId = (index: number) => id + ':cycle-' + index
  const fresh = { cycleId: cycleId(1), bankVersion: bank.version, consumedSourceIds: [], reservedSourceIds: [] }
  const prepared = prepareBatchInventory({ bank, eligibilityPolicy, cycleState: fresh })
  if (!prepared.ok) throw new StorageError('CORRUPT')
  const inventory = Object.freeze([...prepared.inventory.eligibleIds])
  const allowed = new Set(inventory)
  const finalOnly = new Set(prepared.inventory.eligibleQuestions.filter(({ finalOnly }) => finalOnly).map(({ sourceId }) => sourceId))

  const plan = (cycle: Pick<TrackedCycle, 'id' | 'bankVersion' | 'consumedSourceIds' | 'reservedSourceIds'>, ordinal: number) => {
    const result = generateCycleBatch({ bank, eligibilityPolicy, seed: cycle.id + ':exam-' + ordinal, cycleState: {
      cycleId: cycle.id, bankVersion: cycle.bankVersion, consumedSourceIds: cycle.consumedSourceIds, reservedSourceIds: cycle.reservedSourceIds,
    } })
    if (!result.ok || result.batch.sourceIds.some(key => !allowed.has(key))) throw new StorageError('CORRUPT')
    return result.batch
  }

  const forBatch = (batch: GeneratedBatch): FoundationSource =>
    ({ ...sourceFor(batch), idbName, batch, attemptId: batch.id, eligibleSourceIds: inventory })

  const term = (lifecycle: CycleLifecycle, batch: GeneratedBatch, at: number): CycleLifecycle => {
    const next = transitionCycleLifecycle(lifecycle, { type: 'GENERATE', batch, at })
    if (!next.ok) throw new StorageError('CYCLE_CONFLICT')
    return next.state
  }

  function activePlan(record: SavedCandidate) {
    const { attempt, cycle } = record
    if (cycle.lifecycle?.id !== id || !isCycleLifecycle(cycle.lifecycle)) throw new StorageError('CORRUPT')
    const active = activeExamCycle(cycle.lifecycle)
    const last = active.batches.at(-1)?.batch
    if (!last || active.id !== cycleId(cycle.lifecycle.cycles.length) || active.id !== cycle.id || attempt.cycleId !== cycle.id
      || last.id !== attempt.batch.id || last.id !== attempt.id || cycle.contentVersion !== bank.version
      || active.bankVersion !== bank.version || active.eligibilityPolicy !== eligibilityPolicy
      || active.consumedSourceIds.some(key => !allowed.has(key)) || last.sourceIds.some(key => !allowed.has(key))
      || (active.status === 'COMPLETE' ? active.consumedSourceIds.length !== inventory.length : active.consumedSourceIds.length >= inventory.length)) {
      throw new StorageError('CORRUPT')
    }
    const lastIds = new Set(last.sourceIds)
    const marked = last.sourceIds.filter(key => finalOnly.has(key))
    if (last.kind === 'FINAL_REMAINDER_BATCH') {
      // Reject a persisted final draft that silently omitted an ID from the
      // complete pinned universe, or changed its deferred placement evidence.
      const usedBefore = new Set(active.consumedSourceIds.filter(key => !lastIds.has(key)))
      if (inventory.some(key => !usedBefore.has(key) && !lastIds.has(key))
        || marked.length !== (last.finalOnlySourceIds?.length ?? 0)
        || marked.some((key, index) => key !== last.finalOnlySourceIds?.[index])) throw new StorageError('CORRUPT')
    } else if (marked.length) throw new StorageError('CORRUPT')
    return last
  }

  return Object.freeze({
    initial: () => forBatch(plan({ id: fresh.cycleId, ...fresh }, 1)),
    sourceForRecord: (record: SavedCandidate) => forBatch(activePlan(record)),
    advance(record: SavedCandidate, action: JourneyAdvance, observedAt: number): NextCandidate {
      const currentBatch = activePlan(record)
      const previousSource = forBatch(currentBatch)
      if (!canAdvanceCandidate(record.attempt, Boolean(previousSource.scoring))) throw new StorageError('CYCLE_CONFLICT')
      const at = Math.max(observedAt, record.cycle.lifecycle.updatedAt, record.attempt.updatedAt ?? 0)
      let state = record.cycle.lifecycle
      const old = activeExamCycle(state)
      if (action === 'START_NEW_CYCLE') {
        if (old.status !== 'COMPLETE' || old.consumedSourceIds.length !== inventory.length) throw new StorageError('CYCLE_CONFLICT')
        const transition = transitionCycleLifecycle(state, {
          type: 'START_NEW_CYCLE', bankVersion: bank.version, eligibilityPolicy, cycleId: cycleId(state.cycles.length + 1), at,
        })
        if (!transition.ok) throw new StorageError('CYCLE_CONFLICT')
        state = transition.state
      } else if (old.status !== 'ACTIVE') throw new StorageError('CYCLE_CONFLICT')
      const active = activeExamCycle(state)
      const batch = plan(active, active.batches.length + 1)
      const source = forBatch(batch)
      return { source, attempt: newCandidateAttempt(source, at),
        cycle: { id: active.id, contentVersion: bank.version, lifecycle: term(state, batch, at) } }
    },
  })
}
