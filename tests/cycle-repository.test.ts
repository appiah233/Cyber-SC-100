import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import type { GeneratedRemainderBatch } from '../src/domain/batch-engine'
import { activeExamCycle, createCycleLifecycle } from '../src/domain/cycle-lifecycle'
import { createCycleRepository } from '../src/storage/cycle-repository'
import type { CycleWriteGuard } from '../src/storage/cycle-repository'
import { createExamRepository } from '../src/storage'

const bankVersion = 'bank-v1'
const registryId = 'synthetic-registry'
const cycleId = 'synthetic-cycle'
const batch: GeneratedRemainderBatch = {
  id: 'synthetic-plan', kind: 'FINAL_REMAINDER_BATCH', cycleId, contentVersion: bankVersion,
  seed: 'seed-a', eligibilityPolicy: 'DEVELOPMENT', mode: 'DEVELOPMENT',
  sourceIds: ['synthetic-item-a'], total: 1,
  sections: [{ kind: 'FINAL_INTERACTIVE_BLOCK', questionIds: ['synthetic-item-a'] }],
  optionOrder: { 'synthetic-item-a': ['o2', 'o1'] },
  interactionKinds: { 'synthetic-item-a': 'DROPDOWN_HOTSPOT' },
  normalFailure: 'INTERACTIVE_POOL_EXHAUSTED',
}

describe('writer-fenced cycle registry', () => {
  let factory: IDBFactory
  let now: number
  const open = () => createCycleRepository({ indexedDB: factory, now: () => now, leaseDurationMs: 500 })

  async function initialize(repo = open()): Promise<CycleWriteGuard> {
    const state = createCycleLifecycle({ id: registryId, cycleId, bankVersion, eligibilityPolicy: 'DEVELOPMENT',
      createdAt: now })
    const lease = await repo.initialize({ state, writerId: 'writer-tab' })
    return { registryId, expectedRevision: 0, lease, loadedBankVersion: bankVersion }
  }

  beforeEach(() => {
    factory = new IDBFactory()
    now = 1_000
  })

  it('reloads generated seed/roles, reserved membership, and retired state in separate connections', async () => {
    const repo = open()
    const guard = await initialize(repo)
    await repo.apply({ ...guard, command: { type: 'GENERATE', batch, at: ++now } })
    repo.close()
    const reopened = open()
    const generated = await reopened.load(registryId, bankVersion)
    expect(generated?.compatibility).toBe('COMPATIBLE')
    if (!generated) throw new Error('Expected saved cycle')
    expect(activeExamCycle(generated.state).batches[0].batch).toEqual(batch)
    expect(activeExamCycle(generated.state).reservedSourceIds).toEqual([])
    await reopened.apply({ ...guard, expectedRevision: 1, command: { type: 'START', batchId: batch.id, at: ++now } })
    const started = await open().load(registryId, bankVersion)
    if (!started) throw new Error('Expected started batch')
    expect(activeExamCycle(started.state).reservedSourceIds).toEqual(batch.sourceIds)
    expect(activeExamCycle(started.state).consumedSourceIds).toEqual([])
    await reopened.apply({ ...guard, expectedRevision: 2, command: { type: 'COMPLETE', batchId: batch.id, at: ++now } })
    const retired = await open().load(registryId, bankVersion)
    if (!retired) throw new Error('Expected retired batch')
    expect(activeExamCycle(retired.state)).toMatchObject({
      status: 'COMPLETE', consumedSourceIds: batch.sourceIds, reservedSourceIds: [],
    })
    expect(Object.isFrozen(activeExamCycle(retired.state).batches[0].batch.optionOrder['synthetic-item-a'])).toBe(true)
  })

  it('allows only one simultaneous mutation at the same cycle revision', async () => {
    const guard = await initialize()
    const results = await Promise.allSettled([
      open().apply({ ...guard, command: { type: 'GENERATE', batch, at: now } }),
      open().apply({ ...guard, command: { type: 'GENERATE', batch: { ...batch, id: 'competing' }, at: now } }),
    ])
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((entry) => entry.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'STALE_REVISION' }) }),
    ])
    const saved = await open().load(registryId, bankVersion)
    expect(saved?.state.revision).toBe(1)
    expect(saved?.state.cycles[0].batches).toHaveLength(1)
  })

  it('blocks another tab from planning or mutating and fences an expired previous editor', async () => {
    const guard = await initialize()
    const secondary = open()
    const guessed = { ...guard, lease: { ...guard.lease, writerId: 'read-only-tab' } }
    await expect(secondary.readForWrite(guessed)).rejects.toMatchObject({ code: 'LEASE_LOST' })
    await expect(secondary.apply({ ...guessed, command: { type: 'GENERATE', batch, at: now } }))
      .rejects.toMatchObject({ code: 'LEASE_LOST' })
    await expect(secondary.acquireWriter(registryId, 'read-only-tab')).rejects.toMatchObject({ code: 'WRITER_ACTIVE' })
    now = guard.lease.expiresAt
    await expect(secondary.acquireWriter(registryId, 'read-only-tab')).rejects.toMatchObject({ code: 'TAKEOVER_REQUIRED' })
    const nextLease = await secondary.acquireWriter(registryId, 'read-only-tab', {
      takeover: true, expectedToken: guard.lease.token,
    })
    await expect(open().apply({ ...guard, command: { type: 'GENERATE', batch, at: now } }))
      .rejects.toMatchObject({ code: 'LEASE_LOST' })
    await expect(secondary.apply({ ...guard, lease: nextLease, command: { type: 'GENERATE', batch, at: now } }))
      .resolves.toMatchObject({ ok: true })
  })

  it('reports a changed bank without mutation and pins explicit new cycles separately', async () => {
    const repo = open()
    const guard = await initialize(repo)
    const nextVersion = 'bank-v2'
    const drifted = { ...guard, loadedBankVersion: nextVersion }
    expect((await repo.load(registryId, nextVersion))?.compatibility).toBe('INCOMPATIBLE')
    expect((await repo.load(registryId, nextVersion, true))?.compatibility).toBe('MIGRATION_REQUIRED')
    await expect(repo.apply({ ...drifted, command: { type: 'GENERATE', batch, at: now } }))
      .resolves.toEqual({ ok: false, reason: 'BANK_VERSION_MISMATCH' })
    expect((await repo.load(registryId, bankVersion))?.state.revision).toBe(0)
    await repo.apply({ ...guard, command: { type: 'COMPLETE_CYCLE', unusedEligibleSourceIds: [], at: ++now } })
    await repo.apply({ ...drifted, expectedRevision: 1, command: { type: 'START_NEW_CYCLE',
      cycleId: 'new-cycle', bankVersion: nextVersion, eligibilityPolicy: 'DEVELOPMENT', at: ++now } })
    const saved = await open().load(registryId, nextVersion)
    expect(saved?.state.cycles.map(({ id, bankVersion: version, status }) => ({ id, version, status }))).toEqual([
      { id: cycleId, version: bankVersion, status: 'COMPLETE' },
      { id: 'new-cycle', version: nextVersion, status: 'ACTIVE' },
    ])
    expect(saved?.lease?.token).toBe(guard.lease.token)
    expect(saved?.compatibility).toBe('COMPATIBLE')
  })

  it('checks an existing Phase 2 envelope version before a current-bank-only validator', async () => {
    const old = createExamRepository({ indexedDB: factory })
    await old.initialize({ attempt: { id: 'attempt', cycleId: 'preview-cycle', revision: 0 },
      cycle: { id: 'preview-cycle' }, contentVersion: 'old-preview', writerId: 'writer' })
    const current = createExamRepository({ indexedDB: factory, validateAttempt: () => false })
    await expect(current.load('attempt', 'new-preview')).rejects.toMatchObject({ code: 'CONTENT_VERSION_MISMATCH' })
    await expect(current.load('attempt', 'old-preview')).rejects.toMatchObject({ code: 'CORRUPT' })
  })
})
