import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createExamRepository,
  type RepositoryOptions,
  type WriterLease,
} from '../src/storage';

interface DemoAttempt {
  readonly id: string;
  readonly cycleId: string;
  readonly contentVersion: string;
  readonly revision: number;
  readonly batch: { readonly id: string; readonly seed: string; readonly questionIds: readonly string[] };
  readonly lockIds: readonly string[];
  readonly answers: Readonly<Record<string, string>>;
  readonly reviewMarks: readonly string[];
  readonly status: string;
}

interface DemoCycle {
  readonly id: string;
  readonly contentVersion: string;
  readonly consumedQuestionIds: readonly string[];
}

const attempt: DemoAttempt = {
  id: 'attempt-1',
  cycleId: 'cycle-1',
  contentVersion: 'synthetic-v1',
  revision: 0,
  batch: { id: 'synthetic-batch', seed: 'demo-seed', questionIds: ['demo-item'] },
  lockIds: [],
  answers: {},
  reviewMarks: [],
  status: 'READY',
};

const cycle: DemoCycle = {
  id: attempt.cycleId,
  contentVersion: attempt.contentVersion,
  consumedQuestionIds: ['demo-item'],
};

const answered: DemoAttempt = {
  ...attempt,
  revision: 1,
  answers: { 'demo-item': 'option-demo' },
  reviewMarks: ['demo-item'],
  lockIds: ['CASE_STUDY_1'],
  status: 'CASE_STUDY_1_SUBMITTED',
};

describe('offline IndexedDB repository', () => {
  let factory: IDBFactory;
  let timestamp: number;

  function open(options: RepositoryOptions<DemoAttempt, DemoCycle> = {}) {
    return createExamRepository<DemoAttempt, DemoCycle>({
      indexedDB: factory,
      now: () => timestamp,
      leaseDurationMs: 500,
      ...options,
    });
  }

  async function initialize(repo = open()): Promise<WriterLease> {
    return repo.initialize({ attempt, cycle, contentVersion: 'synthetic-v1', writerId: 'tab-a' });
  }

  beforeEach(() => {
    factory = new IDBFactory();
    timestamp = 1_000;
  });

  it('returns no attempt before initialization', async () => {
    await expect(open().load(attempt.id)).resolves.toBeNull();
  });

  it('resumes the exact committed attempt, cycle, answers and review marks after reopening', async () => {
    const original = open();
    const lease = await initialize(original);
    await original.save({ attempt: answered, expectedRevision: 0, lease });
    original.close();
    const restored = await open().load(attempt.id, 'synthetic-v1');
    expect(restored?.attempt).toEqual(answered);
    expect(restored?.cycle).toEqual(cycle);
    expect(restored?.attempt).not.toBe(answered);
    expect(restored?.lease?.token).toBe(1);
  });

  it('keeps existing state and refuses to resume an incompatible content version', async () => {
    const repo = open();
    await initialize(repo);
    await expect(repo.load(attempt.id, 'synthetic-v2'))
      .rejects.toMatchObject({ code: 'CONTENT_VERSION_MISMATCH' });
    await expect(repo.load(attempt.id, 'synthetic-v1'))
      .resolves.toMatchObject({ contentVersion: 'synthetic-v1', attempt });
  });

  it('gives a concurrent editor no write lease while the first lease is active', async () => {
    const tabA = open();
    const tabB = open();
    const a = await initialize(tabA);
    await expect(tabB.acquireWriter(attempt.id, 'tab-b', { takeover: true, expectedToken: a.token }))
      .rejects.toMatchObject({ code: 'WRITER_ACTIVE' });
    await expect(tabB.load(attempt.id)).resolves.toMatchObject({ attempt, lease: a });
  });

  it('requires a checked takeover after expiry and fences the old writer', async () => {
    const a = await initialize();
    const tabB = open();
    timestamp = a.expiresAt;
    await expect(tabB.acquireWriter(attempt.id, 'tab-b'))
      .rejects.toMatchObject({ code: 'TAKEOVER_REQUIRED' });
    const b = await tabB.acquireWriter(attempt.id, 'tab-b', {
      takeover: true,
      expectedToken: a.token,
    });
    expect(b.token).toBeGreaterThan(a.token);
    await expect(open().save({ attempt: answered, expectedRevision: 0, lease: a }))
      .rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(tabB.save({ attempt: answered, expectedRevision: 0, lease: b }))
      .resolves.toEqual(answered);
  });

  it('increases the fence after a verified release and rejects late releases', async () => {
    const tabA = open();
    const a = await initialize(tabA);
    await tabA.releaseWriter(attempt.id, a);
    await expect(open().load(attempt.id)).resolves.toMatchObject({ lease: null });
    const b = await open().acquireWriter(attempt.id, 'tab-b');
    expect(b.token).toBeGreaterThan(a.token);
    await expect(tabA.releaseWriter(attempt.id, a)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(open().load(attempt.id)).resolves.toMatchObject({ lease: b });
  });

  it('renews the existing lease fence on a valid save', async () => {
    const repo = open();
    const a = await initialize(repo);
    timestamp += 400;
    await repo.save({ attempt: answered, expectedRevision: 0, lease: a });
    const saved = await repo.load(attempt.id);
    expect(saved?.lease).toEqual({ writerId: a.writerId, token: a.token, expiresAt: timestamp + 500 });
  });

  it('rejects stale revisions and requires exactly one revision per committed transition', async () => {
    const repo = open();
    const lease = await initialize(repo);
    await expect(repo.save({ attempt: { ...answered, revision: 2 }, expectedRevision: 0, lease }))
      .rejects.toMatchObject({ code: 'STALE_REVISION' });
    await repo.save({ attempt: answered, expectedRevision: 0, lease });
    await expect(repo.save({ attempt: answered, expectedRevision: 0, lease }))
      .rejects.toMatchObject({ code: 'STALE_REVISION' });
    expect((await repo.load(attempt.id))?.attempt).toEqual(answered);
  });

  it('allows exactly one concurrent commit for the same snapshot revision', async () => {
    const lease = await initialize();
    const result = await Promise.allSettled([
      open().save({ attempt: answered, expectedRevision: 0, lease }),
      open().save({ attempt: { ...answered, reviewMarks: [] }, expectedRevision: 0, lease }),
    ]);
    expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter((item) => item.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'STALE_REVISION' }) }),
    ]);
  });

  it('updates a versioned cycle atomically with its attempt', async () => {
    const repo = open();
    const lease = await initialize(repo);
    const updatedCycle = { ...cycle, consumedQuestionIds: [...cycle.consumedQuestionIds, 'demo-extra'] };
    await expect(repo.save({
      attempt: answered,
      expectedRevision: 0,
      lease,
      cycleUpdate: { cycle: updatedCycle, expectedRevision: 2 },
    })).rejects.toMatchObject({ code: 'CYCLE_CONFLICT' });
    await expect(repo.load(attempt.id)).resolves.toMatchObject({ attempt, cycle, cycleRevision: 0 });
    await repo.save({
      attempt: answered,
      expectedRevision: 0,
      lease,
      cycleUpdate: { cycle: updatedCycle, expectedRevision: 0 },
    });
    await expect(repo.load(attempt.id)).resolves.toMatchObject({
      attempt: answered,
      cycle: updatedCycle,
      cycleRevision: 1,
    });
  });

  it('requires a matching cycle revision when initializing a subsequent attempt', async () => {
    const repo = open();
    await initialize(repo);
    const nextAttempt = { ...attempt, id: 'attempt-2' };
    const nextCycle = { ...cycle, consumedQuestionIds: ['demo-item', 'demo-extra'] };
    const next = { attempt: nextAttempt, cycle: nextCycle, contentVersion: 'synthetic-v1', writerId: 'tab-a' };
    await expect(repo.initialize(next)).rejects.toMatchObject({ code: 'CYCLE_CONFLICT' });
    await expect(repo.load(nextAttempt.id)).resolves.toBeNull();
    await repo.initialize({ ...next, expectedCycleRevision: 0 });
    await expect(repo.load(nextAttempt.id)).resolves.toMatchObject({ cycle: nextCycle, cycleRevision: 1 });
    await expect(repo.load(attempt.id)).resolves.toMatchObject({ cycle: nextCycle, cycleRevision: 1 });
  });

  it('rolls back the cycle update when a structured-clone failure prevents the attempt save', async () => {
    const repo = open();
    const lease = await initialize(repo);
    // A function is intentionally unpersistable: no part of this transaction may survive.
    const unpersistable = { ...answered, callback: () => undefined };
    const updatedCycle = { ...cycle, consumedQuestionIds: ['demo-extra'] };
    await expect(repo.save({
      attempt: unpersistable,
      expectedRevision: 0,
      lease,
      cycleUpdate: { cycle: updatedCycle, expectedRevision: 0 },
    })).rejects.toMatchObject({ code: 'CORRUPT' });
    await expect(repo.load(attempt.id)).resolves.toMatchObject({ attempt, cycle, cycleRevision: 0 });
  });

  it('preserves corrupt snapshots for recovery rather than resetting or unlocking them', async () => {
    await initialize();
    const stricter = open({ validateAttempt: () => false });
    await expect(stricter.load(attempt.id)).rejects.toMatchObject({ code: 'CORRUPT' });
    await expect(open().load(attempt.id)).resolves.toMatchObject({ attempt });
  });

  it('returns an explicit disabled-storage error and does not fall back to memory', async () => {
    const repo = open({ indexedDB: null });
    await expect(repo.load(attempt.id)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(initialize(repo)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(open().load(attempt.id)).resolves.toBeNull();
  });

  it('normalizes quota errors without including underlying storage details', async () => {
    const limited = {
      open() { throw new DOMException('raw quota details', 'QuotaExceededError'); },
    } as unknown as IDBFactory;
    await expect(initialize(open({ indexedDB: limited }))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      message: 'Browser storage is full. Changes were not saved.',
    });
  });
});
