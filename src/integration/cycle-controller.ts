import { prepareBatchInventory } from '../domain/batch-engine'
import { generateCycleBatch } from '../domain/cycle-plan'
import type { BatchBank, BatchCycleState } from '../domain/batch-engine'
import { activeExamCycle, createCycleLifecycle } from '../domain/cycle-lifecycle'
import type { CycleLifecycleCommand, CycleLifecycle } from '../domain/cycle-lifecycle'
import { createCycleRepository } from '../storage/cycle-repository'
import { StorageError } from '../storage'
import type { WriterLease } from '../storage'
import type { Seed } from '../domain/model'

type LocalRepo = ReturnType<typeof createCycleRepository>
type Next = ReturnType<typeof generateCycleBatch>
export type WritableCycle = { readonly state: CycleLifecycle; readonly lease: WriterLease }

const generationState = (state: CycleLifecycle): BatchCycleState => {
  const cycle = activeExamCycle(state)
  return { cycleId: cycle.id, bankVersion: cycle.bankVersion, status: cycle.status,
    consumedSourceIds: cycle.consumedSourceIds, reservedSourceIds: cycle.reservedSourceIds }
}

/** Composes pure planning with the Phase 2 repository fence. Does not render UI,
 * import real content, open a connection to a server, or decide source eligibility. */
export function createCycleController(bank: BatchBank, repository: LocalRepo = createCycleRepository()) {
  const issued = new WeakSet<WritableCycle>()
  const sessionFor = (state: CycleLifecycle, lease: WriterLease): WritableCycle => {
    const session=Object.freeze({state,lease})
    issued.add(session)
    return session
  }
  const checkSession = (session: WritableCycle) => {
    if (!issued.has(session)) throw new StorageError('LEASE_LOST')
  }
  const guard = (session: WritableCycle, loadedBankVersion = bank.version) => ({
    registryId:session.state.id,expectedRevision:session.state.revision,lease:session.lease,loadedBankVersion,
  })
  async function commit(session: WritableCycle, command: CycleLifecycleCommand) {
    checkSession(session)
    const version=command.type==='START_NEW_CYCLE' ? command.bankVersion : bank.version
    const result=await repository.apply({...guard(session,version),command})
    return result.ok ? {...result,session:sessionFor(result.state,session.lease)} : result
  }

  return Object.freeze({
    initialize: async (options: Omit<Parameters<typeof createCycleLifecycle>[0], 'bankVersion'>, writerId: string) => {
      const state=createCycleLifecycle({...options,bankVersion:bank.version})
      const lease=await repository.initialize({state,writerId})
      return sessionFor(state,lease)
    },
    load: (registryId: string, pinnedBankAvailable = false) => repository.load(registryId,bank.version,pinnedBankAvailable),
    acquire: async (registryId: string, writerId: string, takeover?: { takeover: true; expectedToken: number }) => {
      const prior=await repository.load(registryId,bank.version)
      if (!prior) throw new StorageError('NOT_FOUND')
      if (activeExamCycle(prior.state).bankVersion!==bank.version) throw new StorageError('CONTENT_VERSION_MISMATCH')
      const lease=await repository.acquireWriter(registryId,writerId,takeover)
      const saved=await repository.load(registryId,bank.version)
      if (!saved || saved.lease?.writerId!==lease.writerId || saved.lease.token!==lease.token) throw new StorageError('LEASE_LOST')
      return sessionFor(saved.state,lease)
    },
    async generate(session: WritableCycle, seed: Seed, at: number) {
      // Check the lease and fresh revision first. Losing this race in apply() still cannot expose a competing draft.
      checkSession(session)
      const saved=await repository.readForWrite(guard(session))
      if (saved.compatibility!=='COMPATIBLE') throw new StorageError('CONTENT_VERSION_MISMATCH')
      const plan: Next = generateCycleBatch({bank,cycleState:generationState(saved.state),eligibilityPolicy:activeExamCycle(saved.state).eligibilityPolicy,seed})
      if (!plan.ok) return {ok:false as const,plan}
      const result=await commit(session,{type:'GENERATE',batch:plan.batch,at})
      if (!result.ok) return {ok:false as const,reason:result.reason}
      return {ok:true as const,plan,session:result.session}
    },
    transition(session: WritableCycle, command: Extract<CycleLifecycleCommand,{type:'START'|'COMPLETE'|'ABANDON'|'INVALIDATE'}>) {
      return commit(session,command)
    },
    completeIfExhausted(session: WritableCycle, at: number) {
      checkSession(session)
      const cycle=activeExamCycle(session.state)
      const prepared=prepareBatchInventory({bank,cycleState:generationState(session.state),eligibilityPolicy:cycle.eligibilityPolicy})
      if (!prepared.ok && prepared.reason !== 'CYCLE_EXHAUSTED') return Promise.resolve({ok:false as const,reason:prepared.reason})
      if (prepared.ok && prepared.inventory.eligibleIds.length!==0) return Promise.resolve({ok:false as const,reason:'ELIGIBLE_CONTENT_REMAINS' as const})
      return commit(session,{type:'COMPLETE_CYCLE',unusedEligibleSourceIds:[],at})
    },
    startNewCycle(session: WritableCycle, cycleId: string, at: number, nextBankVersion = bank.version) {
      return commit(session,{type:'START_NEW_CYCLE',cycleId,bankVersion:nextBankVersion,
        eligibilityPolicy:activeExamCycle(session.state).eligibilityPolicy,at})
    },
    release: async (session: WritableCycle) => {
      checkSession(session)
      await repository.readForWrite(guard(session))
      issued.delete(session)
      return repository.releaseWriter(session.state.id,session.lease)
    },
  })
}
