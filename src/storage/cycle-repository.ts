import {
  activeExamCycle,
  cycleCompatibility,
  isCycleLifecycle,
  restoreCycleLifecycle,
  transitionCycleLifecycle,
} from '../domain/cycle-lifecycle'
import type {
  CycleCompatibility,
  CycleLifecycle,
  CycleLifecycleCommand,
  CycleLifecycleResult,
} from '../domain/cycle-lifecycle'
import { createExamRepository, EXAM_STORAGE_DATABASE, StorageError } from './index'
import type { WriterLease } from './index'

const STORAGE_CODEC = 'exam-cycle-engine-v1'
export const CYCLE_STORAGE_DATABASE = 'examination-hub:Cyber-SC-100:cycle-engine'

interface RegistryRecord {
  readonly id: string
  /** Stable storage fence, not the movable active cycle ID. */
  readonly cycleId: string
  readonly contentVersion: typeof STORAGE_CODEC
  readonly revision: number
  readonly state: CycleLifecycle
}

interface RegistryMarker {
  readonly id: string
  readonly contentVersion: typeof STORAGE_CODEC
}

export interface CycleRepositoryOptions {
  readonly databaseName?: string
  readonly indexedDB?: IDBFactory | null
  readonly now?: () => number
  readonly leaseDurationMs?: number
}

export interface SavedCycleLifecycle {
  readonly state: CycleLifecycle
  readonly lease: WriterLease | null
  /** Null if the caller has not loaded any bank. */
  readonly compatibility: CycleCompatibility | null
}

export interface CycleWriteGuard {
  readonly registryId: string
  readonly expectedRevision: number
  readonly lease: WriterLease
  readonly loadedBankVersion: string
  readonly pinnedBankAvailable?: boolean
}

export interface CycleRepository {
  initialize(input: { readonly state: CycleLifecycle; readonly writerId: string }): Promise<WriterLease>
  load(registryId: string, loadedBankVersion?: string, pinnedBankAvailable?: boolean): Promise<SavedCycleLifecycle | null>
  acquireWriter(
    registryId: string,
    writerId: string,
    options?: { readonly takeover?: boolean; readonly expectedToken?: number },
  ): Promise<WriterLease>
  /** Check a lease before running a planner in the application layer. Commit re-checks it atomically. */
  readForWrite(input: CycleWriteGuard): Promise<SavedCycleLifecycle>
  apply(input: CycleWriteGuard & { readonly command: CycleLifecycleCommand }): Promise<CycleLifecycleResult>
  releaseWriter(registryId: string, lease: WriterLease): Promise<void>
  close(): void
}

function snapshot(state: CycleLifecycle): RegistryRecord {
  return {
    id: state.id,
    cycleId: state.id,
    contentVersion: STORAGE_CODEC,
    revision: state.revision,
    state,
  }
}

/**
 * Uses the Phase 2 IndexedDB CAS and writer lease against a stable registry row.
 * Keeping every cycle's history in the same value makes closing/starting cycles
 * transactional, without handing out a second independently writable lease.
 */
export function createCycleRepository(options: CycleRepositoryOptions = {}): CycleRepository {
  const databaseName = options.databaseName ?? CYCLE_STORAGE_DATABASE
  if (databaseName === EXAM_STORAGE_DATABASE) {
    throw new RangeError('Use a separate cycle-engine registry namespace from the foundation preview.')
  }
  const now = options.now ?? Date.now
  const adapter = createExamRepository<RegistryRecord, RegistryMarker>({
    ...options,
    databaseName,
    now,
    validateAttempt(value) {
      return value.contentVersion === STORAGE_CODEC && value.id === value.cycleId
        && isCycleLifecycle(value.state)
        && value.state.id === value.id && value.state.revision === value.revision
    },
    validateCycle: (marker) => marker.contentVersion === STORAGE_CODEC,
  })

  async function load(
    registryId: string,
    loadedBankVersion?: string,
    pinnedBankAvailable = false,
  ): Promise<SavedCycleLifecycle | null> {
    // Codec pin and bank pin are different: one registry holds historical bank versions.
    const saved = await adapter.load(registryId, STORAGE_CODEC)
    if (!saved) return null
    const state = restoreCycleLifecycle(saved.attempt.state)
    return {
      state,
      lease: saved.lease,
      compatibility: loadedBankVersion === undefined
        ? null
        : cycleCompatibility(activeExamCycle(state).bankVersion, loadedBankVersion, pinnedBankAvailable),
    }
  }

  async function readForWrite(input: CycleWriteGuard): Promise<SavedCycleLifecycle> {
    const saved = await load(input.registryId, input.loadedBankVersion, input.pinnedBankAvailable)
    if (!saved) throw new StorageError('NOT_FOUND')
    if (!saved.lease || saved.lease.expiresAt <= now() || !input.lease
      || saved.lease.writerId !== input.lease.writerId || saved.lease.token !== input.lease.token) {
      throw new StorageError('LEASE_LOST')
    }
    if (saved.state.revision !== input.expectedRevision) throw new StorageError('STALE_REVISION')
    return saved
  }

  return {
    async initialize({ state, writerId }) {
      if (!isCycleLifecycle(state) || state.revision !== 0 || state.cycles.length !== 1
        || activeExamCycle(state).status !== 'ACTIVE' || activeExamCycle(state).batches.length !== 0) {
        throw new StorageError('CORRUPT')
      }
      return adapter.initialize({
        attempt: snapshot(state),
        cycle: { id: state.id, contentVersion: STORAGE_CODEC },
        contentVersion: STORAGE_CODEC,
        writerId,
      })
    },
    load,
    acquireWriter: (registryId, writerId, settings) => adapter.acquireWriter(registryId, writerId, settings),
    readForWrite,
    async apply(input) {
      const saved = await readForWrite(input)
      // Switching banks needs either the exact pinned bank or a new cycle after
      // closing this one. No command rewrites a historical batch or substitutes IDs.
      if (input.command.type === 'START_NEW_CYCLE'
        ? input.command.bankVersion !== input.loadedBankVersion
        : saved.compatibility !== 'COMPATIBLE') {
        return { ok: false, reason: 'BANK_VERSION_MISMATCH' }
      }
      const changed = transitionCycleLifecycle(saved.state, input.command)
      if (!changed.ok) return changed
      const persisted = await adapter.save({
        attempt: snapshot(changed.state),
        expectedRevision: input.expectedRevision,
        lease: input.lease,
      })
      return { ok: true, state: restoreCycleLifecycle(persisted.state) }
    },
    releaseWriter: (registryId, lease) => adapter.releaseWriter(registryId, lease),
    close: () => adapter.close(),
  }
}
