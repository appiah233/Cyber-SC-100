import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { isAttemptSnapshot } from '../src/domain'
import { activeExamCycle, isCycleLifecycle } from '../src/domain/cycle-lifecycle'
import type { BatchBank } from '../src/domain/batch-engine'
import { createExamRepository } from '../src/storage'
import type { SavedExam, WriterLease } from '../src/storage'
import { candidateChange, candidateValidators, initialCandidate, isTerminalAttempt } from '../src/integration/candidate-attempt'
import type { CandidateCycle, CandidateSnapshot, FoundationSource } from '../src/integration/candidate-attempt'
import { createCandidateJourney } from '../src/integration/candidate-journey'
import type { JourneyAdvance } from '../src/integration/candidate-journey'

const bank: BatchBank = {
  version: 'synthetic-journey-bank-v1', caseStudies: [],
  questions: Array.from({ length: 60 }, (_, i) => ({
    sourceId: 'item-' + i, interactionKind: 'SINGLE_CHOICE', standardEligible: true,
    developmentValidated: true, productionEligible: false,
  })),
}

function harness() {
  const id = 'synthetic-journey'
  const idbName = 'journey-tests'
  const indexedDB = new IDBFactory()
  let now = 100
  const journey = createCandidateJourney({
    id, idbName, bank, eligibilityPolicy: 'DEVELOPMENT',
    sourceFor: () => ({
      question: (key) => ({ id: key, prompt: 'Synthetic journey proof',
        interaction: { kind: 'SINGLE_CHOICE', options: [{ id: 'a', label: 'A' }] } }),
    }),
  })
  const open = (source?: FoundationSource) => createExamRepository<CandidateSnapshot, CandidateCycle>({
    databaseName: idbName, indexedDB, now: () => now, leaseDurationMs: 1000,
    ...(source ? candidateValidators(source) : { validateAttempt: isAttemptSnapshot, validateCycle: (cycle: CandidateCycle) => isCycleLifecycle(cycle.lifecycle) }),
  })
  const requireRecord = async () => {
    const read = open()
    try {
      const record = await read.loadJourney(id, bank.version)
      if (!record) throw new Error('Missing expected journey record')
      return record
    } finally { read.close() }
  }
  const finish = async (source: FoundationSource, lease: WriterLease) => {
    const writer = open(source)
    try {
      for (const type of ['START', 'END_EXAM'] as const) {
        const current = await requireRecord()
        const next = candidateChange(current.attempt, current.cycle, source, { type }, ++now)
        if (!next) throw new Error('Expected candidate lifecycle transition')
        await writer.save({ attempt: next.attempt, expectedRevision: current.attempt.revision, lease,
          cycleUpdate: { cycle: next.cycle, expectedRevision: current.cycleRevision } })
      }
      return requireRecord()
    } finally { writer.close() }
  }
  const initialize = async () => {
    const source = { ...journey.initial(), journey: { id, advance: journey.advance, onAdvanced() {}, onStale() {} } }
    const attempt = initialCandidate(source, now)
    const writer = open(source)
    const lease = await writer.initialize({ ...attempt, journeyId: id, contentVersion: bank.version, writerId: 'editor' })
    writer.close()
    return { source, lease }
  }
  const prepare = (current: SavedExam<CandidateSnapshot, CandidateCycle>, lease: WriterLease, action: JourneyAdvance) => {
    const next = journey.advance(current, action, ++now)
    return { next, input: { journeyId: id, attemptId: current.attempt.id, expectedRevision: current.attempt.revision,
      expectedCycleRevision: current.cycleRevision, lease, next, validateNext: candidateValidators(next.source),
      canAdvance: isTerminalAttempt } }
  }
  async function corrupt(store: 'attempts' | 'cycles' | 'journeys', key: string) {
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open(idbName)
      r.onerror = () => reject(r.error)
      r.onsuccess = () => {
        const db = r.result
        const tx = db.transaction(store, 'readwrite')
        tx.objectStore(store).delete(key)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onabort = () => reject(tx.error)
      }
    })
  }
  return { id, open, prepare, journey, requireRecord, finish, initialize, corrupt }
}

describe('Atomic candidate journey', () => {
  it('advances an adaptive full exam, remainder and confirmed new cycle while retaining history', async () => {
    const h = harness()
    const first = await h.initialize()
    expect(first.source.batch.total).toBe(59)
    expect(first.source.batch.batchMode).toBe('ADAPTIVE')
    const initial = await h.requireRecord()
    expect(() => h.prepare(initial, first.lease, 'NEXT_EXAM')).toThrow()
    const terminal = await h.finish(first.source, first.lease)
    const oldWriter = h.open(first.source)
    const second = h.prepare(terminal, first.lease, 'NEXT_EXAM')
    const secondLease = await oldWriter.advanceJourney(second.input)
    await expect(oldWriter.advanceJourney(second.input)).rejects.toHaveProperty('code', 'STALE_REVISION')
    expect(second.next.source.batch.total).toBe(1)
    expect(second.next.source.batch.batchMode).toBe('FINAL_REMAINDER')
    expect(new Set([...first.source.batch.sourceIds, ...second.next.source.batch.sourceIds]).size).toBe(60)
    const savedFirst = await oldWriter.load(first.source.attemptId)
    expect(savedFirst?.attempt.status).toBe('SUBMITTED')
    expect(savedFirst?.lease).toBeNull()
    expect(h.journey.sourceForRecord(await h.requireRecord()).batch.id).toBe(second.next.source.batch.id)
    const completed = await h.finish(second.next.source, secondLease)
    expect(activeExamCycle(completed.cycle.lifecycle).consumedSourceIds).toHaveLength(60)
    expect(activeExamCycle(completed.cycle.lifecycle).status).toBe('COMPLETE')
    const fresh = h.prepare(completed, secondLease, 'START_NEW_CYCLE')
    const endingWriter = h.open(second.next.source)
    await endingWriter.advanceJourney(fresh.input)
    const nextCycle = await h.requireRecord()
    expect(nextCycle.attempt.status).toBe('CREATED')
    expect(nextCycle.cycle.lifecycle.cycles.map(({ status }) => status)).toEqual(['COMPLETE', 'ACTIVE'])
    expect(activeExamCycle(nextCycle.cycle.lifecycle).consumedSourceIds).toEqual([])
    expect(nextCycle.cycle.id).not.toBe(completed.cycle.id)
    expect((await endingWriter.load(second.next.source.attemptId))?.attempt.revision).toBe(completed.attempt.revision)
    oldWriter.close()
    endingWriter.close()
  })

  it('rolls back a handoff written up to the pointer update and cannot transfer someone else’s lease', async () => {
    const h = harness()
    const first = await h.initialize()
    const prior = await h.finish(first.source, first.lease)
    const next = h.prepare(prior, first.lease, 'NEXT_EXAM')
    const writer = h.open(first.source)
    await expect(writer.advanceJourney({ ...next.input, lease: { ...first.lease, writerId: 'follower' } }))
      .rejects.toHaveProperty('code', 'LEASE_LOST')
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === 'journeys') throw new DOMException('Synthetic pointer failure', 'QuotaExceededError')
      return key === undefined ? original.call(this, value) : original.call(this, value, key)
    }
    try {
      await expect(writer.advanceJourney(next.input)).rejects.toHaveProperty('code', 'QUOTA_EXCEEDED')
    } finally { IDBObjectStore.prototype.put = original }
    expect(await h.requireRecord()).toEqual(prior)
    const loose = h.open()
    expect(await loose.load(next.next.attempt.id)).toBeNull()
    await writer.advanceJourney(next.input)
    expect((await h.requireRecord()).attempt.id).toBe(next.next.attempt.id)
    writer.close()
    loose.close()
  })

  it.each(['attempts', 'cycles'] as const)('fails closed and does not recreate a missing linked record in %s', async (store) => {
    const h = harness()
    await h.initialize()
    const prior = await h.requireRecord()
    await h.corrupt(store, store === 'attempts' ? prior.attempt.id : prior.cycle.id)
    const loose = h.open()
    await expect(loose.loadJourney(h.id, bank.version)).rejects.toHaveProperty('code', 'CORRUPT')
    await expect(loose.loadJourney(h.id, 'wrong-bank-version')).rejects.toHaveProperty('code', 'CONTENT_VERSION_MISMATCH')
    loose.close()
  })

  it('distinguishes a fresh visit from a missing pointer on an otherwise populated journey', async () => {
    const h = harness()
    const first = await h.initialize()
    await h.corrupt('journeys', h.id)
    const writer = h.open(first.source)
    await expect(writer.loadJourney(h.id, bank.version)).resolves.toBeNull()
    await expect(writer.initialize({
      ...initialCandidate(first.source, 120), journeyId: h.id, contentVersion: bank.version, writerId: 'second-tab',
    })).rejects.toHaveProperty('code', 'CORRUPT')
    expect((await writer.load(first.source.attemptId))?.attempt.status).toBe('CREATED')
    writer.close()
  })
})
