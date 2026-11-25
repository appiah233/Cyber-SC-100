// Offline attempt snapshots only. This adapter has no network or domain dependencies.
export interface AttemptSnapshot {
  readonly id: string;
  readonly cycleId: string;
  readonly revision: number;
}

export interface CycleSnapshot {
  readonly id: string;
}

export interface WriterLease {
  readonly writerId: string;
  readonly token: number;
  readonly expiresAt: number;
}

export type StorageErrorCode =
  | 'UNAVAILABLE'
  | 'QUOTA_EXCEEDED'
  | 'CORRUPT'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'CONTENT_VERSION_MISMATCH'
  | 'STALE_REVISION'
  | 'CYCLE_CONFLICT'
  | 'WRITER_ACTIVE'
  | 'TAKEOVER_REQUIRED'
  | 'LEASE_LOST';

const messages: Record<StorageErrorCode, string> = {
  UNAVAILABLE: 'Browser storage is unavailable. Changes were not saved.',
  QUOTA_EXCEEDED: 'Browser storage is full. Changes were not saved.',
  CORRUPT: 'The local attempt or cycle could not be validated. Nothing was reset.',
  NOT_FOUND: 'The local attempt was not found.',
  ALREADY_EXISTS: 'A local attempt with that ID already exists.',
  CONTENT_VERSION_MISMATCH: 'This attempt is pinned to another content version.',
  STALE_REVISION: 'Your view is out of date. Reload the saved attempt before editing.',
  CYCLE_CONFLICT: 'The saved cycle has changed. Reload it before continuing.',
  WRITER_ACTIVE: 'This attempt is being edited in another tab.',
  TAKEOVER_REQUIRED: 'Confirm the expired editor session before taking over.',
  LEASE_LOST: 'This tab no longer owns the editor lease. Changes were not saved.',
};

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode) {
    super(messages[code]);
    this.name = 'StorageError';
    this.code = code;
  }
}

export interface SavedExam<A extends AttemptSnapshot, C extends CycleSnapshot> {
  readonly attempt: A;
  readonly cycle: C;
  readonly contentVersion: string;
  readonly cycleRevision: number;
  readonly lease: WriterLease | null;
}

export interface RepositoryOptions<A extends AttemptSnapshot, C extends CycleSnapshot> {
  readonly databaseName?: string;
  // Explicit null is useful in tests and hosts where IDB has been disabled.
  readonly indexedDB?: IDBFactory | null;
  readonly now?: () => number;
  readonly leaseDurationMs?: number;
  readonly validateAttempt?: (value: A) => boolean;
  readonly validateCycle?: (value: C) => boolean;
  readonly validatePair?: (attempt: A, cycle: C) => boolean;
}

export interface InitializeExam<A extends AttemptSnapshot, C extends CycleSnapshot> {
  readonly attempt: A;
  readonly cycle: C;
  readonly contentVersion: string;
  readonly writerId: string;
  /** Required to update an already-existing cycle atomically with a new attempt. */
  readonly expectedCycleRevision?: number;
  /** Create the current attempt, cycle, and journey pointer in one transaction. */
  readonly journeyId?: string;
}

export interface SaveExam<A extends AttemptSnapshot, C extends CycleSnapshot> {
  readonly attempt: A;
  readonly expectedRevision: number;
  readonly lease: WriterLease;
  /** Optional atomic cycle update subject to its own revision precondition. */
  readonly cycleUpdate?: { readonly cycle: C; readonly expectedRevision: number };
}

export interface AdvanceJourney<A extends AttemptSnapshot, C extends CycleSnapshot> {
  readonly journeyId: string;
  readonly attemptId: string;
  readonly expectedRevision: number;
  readonly expectedCycleRevision: number;
  readonly lease: WriterLease;
  readonly next: { readonly attempt: A; readonly cycle: C };
  readonly validateNext: Pick<RepositoryOptions<A, C>, 'validateAttempt' | 'validateCycle' | 'validatePair'>;
  readonly canAdvance: (attempt: A, cycle: C) => boolean;
}

export interface ExamRepository<A extends AttemptSnapshot, C extends CycleSnapshot> {
  initialize(input: InitializeExam<A, C>): Promise<WriterLease>;
  load(attemptId: string, expectedContentVersion?: string): Promise<SavedExam<A, C> | null>;
  loadJourney(journeyId: string, expectedContentVersion: string): Promise<SavedExam<A, C> | null>;
  advanceJourney(input: AdvanceJourney<A, C>): Promise<WriterLease>;
  acquireWriter(
    attemptId: string,
    writerId: string,
    options?: { readonly takeover?: boolean; readonly expectedToken?: number },
  ): Promise<WriterLease>;
  save(input: SaveExam<A, C>): Promise<A>;
  releaseWriter(attemptId: string, lease: WriterLease): Promise<void>;
  close(): void;
}

interface AttemptRecord<A> {
  readonly id: string;
  readonly contentVersion: string;
  readonly attempt: A;
  readonly lastToken: number;
  readonly lease: WriterLease | null;
}

interface CycleRecord<C> {
  readonly id: string;
  readonly contentVersion: string;
  readonly cycle: C;
  readonly revision: number;
}

export const EXAM_STORAGE_DATABASE = 'examination-hub:Cyber-SC-100:foundation';
interface JourneyRecord {
  readonly id: string;
  readonly attemptId: string;
  readonly cycleId: string;
  readonly contentVersion: string;
}

const SCHEMA_VERSION = 2;
const ATTEMPTS = 'attempts';
const CYCLES = 'cycles';
const JOURNEYS = 'journeys';

function asStorageError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  if (error instanceof Error && error.name === 'QuotaExceededError') {
    return new StorageError('QUOTA_EXCEEDED');
  }
  if (error instanceof Error && error.name === 'DataCloneError') {
    return new StorageError('CORRUPT');
  }
  return new StorageError('UNAVAILABLE');
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new StorageError('UNAVAILABLE'));
    transaction.onerror = () => reject(transaction.error ?? new StorageError('UNAVAILABLE'));
  });
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, SCHEMA_VERSION);
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(new StorageError('UNAVAILABLE'));
    };
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(ATTEMPTS)) {
        request.result.createObjectStore(ATTEMPTS, { keyPath: 'id' });
      }
      if (!request.result.objectStoreNames.contains(CYCLES)) {
        request.result.createObjectStore(CYCLES, { keyPath: 'id' });
      }
      if (!request.result.objectStoreNames.contains(JOURNEYS)) {
        request.result.createObjectStore(JOURNEYS, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (blocked) {
        database.close();
        return;
      }
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nextRevision(current: number): number {
  const next = current + 1;
  if (!revision(next)) throw new StorageError('CORRUPT');
  return next;
}

function usableLease(value: unknown): value is WriterLease {
  return object(value) && text(value.writerId) && revision(value.token) && value.token > 0
    && typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt);
}

function checkAttempt<A extends AttemptSnapshot>(
  value: unknown,
  validate?: (value: A) => boolean,
): asserts value is A {
  if (!object(value) || !text(value.id) || !text(value.cycleId) || !revision(value.revision)) {
    throw new StorageError('CORRUPT');
  }
  checkExtra(value as unknown as A, validate);
}

function checkCycle<C extends CycleSnapshot>(
  value: unknown,
  validate?: (value: C) => boolean,
): asserts value is C {
  if (!object(value) || !text(value.id)) throw new StorageError('CORRUPT');
  checkExtra(value as unknown as C, validate);
}

function checkExtra<T>(value: T, validate?: (value: T) => boolean): void {
  if (!validate) return;
  try {
    if (validate(value)) return;
  } catch {
    // A malformed persisted snapshot may cause a guard itself to throw.
  }
  throw new StorageError('CORRUPT');
}

function checkEmbeddedVersion(value: object, version: string): void {
  if ('contentVersion' in value && value.contentVersion !== version) {
    throw new StorageError('CONTENT_VERSION_MISMATCH');
  }
}

export function createExamRepository<
  A extends AttemptSnapshot,
  C extends CycleSnapshot,
>(options: RepositoryOptions<A, C> = {}): ExamRepository<A, C> {
  const name = options.databaseName ?? EXAM_STORAGE_DATABASE;
  const now = options.now ?? Date.now;
  const duration = options.leaseDurationMs ?? 30_000;
  if (!text(name) || !Number.isSafeInteger(duration) || duration <= 0) {
    throw new RangeError('Invalid local storage configuration.');
  }
  let closed = false;

  async function run<T>(
    mode: IDBTransactionMode,
    work: (attempts: IDBObjectStore, cycles: IDBObjectStore, journeys: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    let database: IDBDatabase | undefined;
    try {
      const factory = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
      if (closed || !factory) throw new StorageError('UNAVAILABLE');
      database = await openDatabase(factory, name);
      if (closed) throw new StorageError('UNAVAILABLE');
      const transaction = database.transaction([ATTEMPTS, CYCLES, JOURNEYS], mode);
      // Attach to completion before issuing requests. Do not acknowledge a save until commit.
      const done = transactionDone(transaction);
      // Avoid an unhandled rejection if the transaction errors before work has settled.
      void done.catch(() => undefined);
      try {
        const result = await work(transaction.objectStore(ATTEMPTS), transaction.objectStore(CYCLES), transaction.objectStore(JOURNEYS));
        await done;
        return result;
      } catch (error) {
        try { transaction.abort(); } catch { /* Already completed or aborted. */ }
        await done.catch(() => undefined);
        throw error;
      }
    } catch (error) {
      throw asStorageError(error);
    } finally {
      database?.close();
    }
  }

  async function readAttempt(
    store: IDBObjectStore,
    id: string,
    expectedContentVersion?: string,
  ): Promise<AttemptRecord<A> | null> {
    const value: unknown = await requestResult(store.get(id));
    if (value === undefined) return null;
    if (!object(value) || value.id !== id || !text(value.contentVersion) || !revision(value.lastToken)
      || !(value.lease === null || (usableLease(value.lease) && value.lease.token === value.lastToken))) {
      throw new StorageError('CORRUPT');
    }
    if (expectedContentVersion !== undefined && value.contentVersion !== expectedContentVersion) {
      // A validator specialized to the currently loaded bank may reject an older
      // otherwise coherent snapshot. Diagnose the version pin before running it.
      throw new StorageError('CONTENT_VERSION_MISMATCH');
    }
    checkAttempt<A>(value.attempt, options.validateAttempt);
    if (value.attempt.id !== id) throw new StorageError('CORRUPT');
    checkEmbeddedVersion(value.attempt, value.contentVersion);
    return {
      id,
      contentVersion: value.contentVersion,
      attempt: value.attempt,
      lastToken: value.lastToken,
      lease: value.lease,
    };
  }

  async function readCycle(store: IDBObjectStore, id: string): Promise<CycleRecord<C> | null> {
    const value: unknown = await requestResult(store.get(id));
    if (value === undefined) return null;
    if (!object(value) || value.id !== id || !text(value.contentVersion) || !revision(value.revision)) {
      throw new StorageError('CORRUPT');
    }
    checkCycle<C>(value.cycle, options.validateCycle);
    if (value.cycle.id !== id) throw new StorageError('CORRUPT');
    checkEmbeddedVersion(value.cycle, value.contentVersion);
    return { id, contentVersion: value.contentVersion, cycle: value.cycle, revision: value.revision };
  }

  function checkPair(attempt: A, cycle: C): void {
    const validate = options.validatePair;
    if (validate) checkExtra({ attempt, cycle }, (pair) => validate(pair.attempt, pair.cycle));
  }

  async function readJourney(store: IDBObjectStore, id: string, version?: string): Promise<JourneyRecord | null> {
    if (!text(id)) throw new StorageError('CORRUPT');
    const value: unknown = await requestResult(store.get(id));
    if (value === undefined) return null;
    if (!object(value) || value.id !== id || !text(value.attemptId) || !text(value.cycleId) || !text(value.contentVersion)) {
      throw new StorageError('CORRUPT');
    }
    if (version !== undefined && value.contentVersion !== version) throw new StorageError('CONTENT_VERSION_MISMATCH');
    return { id, attemptId: value.attemptId, cycleId: value.cycleId, contentVersion: value.contentVersion };
  }

  async function getSaved(record: AttemptRecord<A>, cycles: IDBObjectStore): Promise<SavedExam<A, C>> {
    const cycle = await readCycle(cycles, record.attempt.cycleId);
    if (!cycle || cycle.contentVersion !== record.contentVersion) throw new StorageError('CORRUPT');
    checkPair(record.attempt, cycle.cycle);
    return {
      attempt: record.attempt, cycle: cycle.cycle, contentVersion: record.contentVersion,
      cycleRevision: cycle.revision, lease: record.lease,
    };
  }

  function issueLease(writerId: string, token: number, timestamp: number): WriterLease {
    const expiry = timestamp + duration;
    if (!text(writerId) || !revision(token) || token === 0 || !Number.isFinite(expiry)) {
      throw new StorageError('CORRUPT');
    }
    return { writerId, token, expiresAt: expiry };
  }

  function assertWriter(record: AttemptRecord<A>, lease: WriterLease, timestamp: number): void {
    if (!usableLease(lease) || !record.lease || record.lease.expiresAt <= timestamp
      || record.lease.writerId !== lease.writerId || record.lease.token !== lease.token) {
      throw new StorageError('LEASE_LOST');
    }
  }

  return {
    initialize(input) {
      return run('readwrite', async (attempts, cycles, journeys) => {
        checkAttempt<A>(input.attempt, options.validateAttempt);
        checkCycle<C>(input.cycle, options.validateCycle);
        checkPair(input.attempt, input.cycle);
        if (!text(input.contentVersion) || input.attempt.cycleId !== input.cycle.id) {
          throw new StorageError('CORRUPT');
        }
        checkEmbeddedVersion(input.attempt, input.contentVersion);
        checkEmbeddedVersion(input.cycle, input.contentVersion);
        if (input.journeyId !== undefined) {
          const link = await readJourney(journeys, input.journeyId, input.contentVersion);
          if (link) throw new StorageError('ALREADY_EXISTS');
          // An existing row with a lost journey pointer is not a fresh visit.
          if (await requestResult(attempts.count(input.attempt.id))) throw new StorageError('CORRUPT');
        } else if (await readAttempt(attempts, input.attempt.id)) throw new StorageError('ALREADY_EXISTS');
        const currentCycle = await readCycle(cycles, input.cycle.id);
        if (input.journeyId !== undefined && currentCycle) throw new StorageError('CORRUPT');
        if (currentCycle && currentCycle.contentVersion !== input.contentVersion) {
          throw new StorageError('CONTENT_VERSION_MISMATCH');
        }
        if ((currentCycle?.revision) !== input.expectedCycleRevision) {
          throw new StorageError('CYCLE_CONFLICT');
        }
        const lease = issueLease(input.writerId, 1, now());
        await requestResult(cycles.put({
          id: input.cycle.id,
          contentVersion: input.contentVersion,
          cycle: input.cycle,
          revision: currentCycle ? nextRevision(currentCycle.revision) : 0,
        } satisfies CycleRecord<C>));
        await requestResult(attempts.add({
          id: input.attempt.id,
          contentVersion: input.contentVersion,
          attempt: input.attempt,
          lastToken: lease.token,
          lease,
        } satisfies AttemptRecord<A>));
        if (input.journeyId !== undefined) await requestResult(journeys.add({
          id: input.journeyId, attemptId: input.attempt.id, cycleId: input.attempt.cycleId, contentVersion: input.contentVersion,
        } satisfies JourneyRecord));
        return lease;
      });
    },

    load(attemptId, expectedContentVersion) {
      return run('readonly', async (attempts, cycles) => {
        const record = await readAttempt(attempts, attemptId, expectedContentVersion);
        if (!record) return null;
        return getSaved(record, cycles);
      });
    },

    loadJourney(journeyId, expectedContentVersion) {
      return run('readonly', async (attempts, cycles, journeys) => {
        const link = await readJourney(journeys, journeyId, expectedContentVersion);
        if (!link) return null;
        const record = await readAttempt(attempts, link.attemptId, link.contentVersion);
        if (!record || record.attempt.cycleId !== link.cycleId) throw new StorageError('CORRUPT');
        return getSaved(record, cycles);
      });
    },

    advanceJourney(input) {
      return run('readwrite', async (attempts, cycles, journeys) => {
        const link = await readJourney(journeys, input.journeyId);
        if (!link) throw new StorageError('CORRUPT');
        if (link.attemptId !== input.attemptId) throw new StorageError('STALE_REVISION');
        const row = await readAttempt(attempts, link.attemptId, link.contentVersion);
        if (!row || row.attempt.cycleId !== link.cycleId) throw new StorageError('CORRUPT');
        const current = await getSaved(row, cycles);
        assertWriter(row, input.lease, now());
        if (current.attempt.revision !== input.expectedRevision) throw new StorageError('STALE_REVISION');
        if (current.cycleRevision !== input.expectedCycleRevision) throw new StorageError('CYCLE_CONFLICT');
        checkExtra(current, ({ attempt, cycle }) => input.canAdvance(attempt, cycle));

        const { attempt, cycle } = input.next;
        checkAttempt<A>(attempt, input.validateNext.validateAttempt);
        checkCycle<C>(cycle, input.validateNext.validateCycle);
        const nextPair = input.validateNext.validatePair;
        if (nextPair) checkExtra({ attempt, cycle }, (entry) => nextPair(entry.attempt, entry.cycle));
        checkEmbeddedVersion(attempt, link.contentVersion);
        checkEmbeddedVersion(cycle, link.contentVersion);
        if (attempt.cycleId !== cycle.id || attempt.id === row.id || attempt.revision !== 0
          || await requestResult(attempts.count(attempt.id))) throw new StorageError('CYCLE_CONFLICT');
        const sameCycle = cycle.id === current.cycle.id;
        if (!sameCycle && await requestResult(cycles.count(cycle.id))) throw new StorageError('CYCLE_CONFLICT');

        const lease = issueLease(row.lease!.writerId, 1, now());
        await requestResult(cycles.put({ id: cycle.id, contentVersion: link.contentVersion,
          cycle, revision: sameCycle ? nextRevision(current.cycleRevision) : 0,
        } satisfies CycleRecord<C>));
        await requestResult(attempts.add({ id: attempt.id, contentVersion: link.contentVersion,
          attempt, lastToken: lease.token, lease,
        } satisfies AttemptRecord<A>));
        await requestResult(attempts.put({ ...row, lease: null }));
        await requestResult(journeys.put({ ...link, attemptId: attempt.id, cycleId: cycle.id } satisfies JourneyRecord));
        return lease;
      });
    },

    acquireWriter(attemptId, writerId, settings = {}) {
      return run('readwrite', async (attempts) => {
        const record = await readAttempt(attempts, attemptId);
        if (!record) throw new StorageError('NOT_FOUND');
        const timestamp = now();
        const active = record.lease !== null && record.lease.expiresAt > timestamp;
        if (active && record.lease?.writerId !== writerId) throw new StorageError('WRITER_ACTIVE');
        if (settings.expectedToken !== undefined && settings.expectedToken !== record.lastToken) {
          throw new StorageError('LEASE_LOST');
        }
        if (record.lease && !active && (!settings.takeover || settings.expectedToken !== record.lastToken)) {
          throw new StorageError('TAKEOVER_REQUIRED');
        }
        // Only a truly new lease increments the fence. Renewal does not invalidate in-flight
        // revisions from the same editor. An expired lease is never renewed in place.
        const lease = issueLease(writerId, active ? record.lastToken : nextRevision(record.lastToken), timestamp);
        await requestResult(attempts.put({ ...record, lastToken: lease.token, lease }));
        return lease;
      });
    },

    save(input) {
      return run('readwrite', async (attempts, cycles) => {
        checkAttempt<A>(input.attempt, options.validateAttempt);
        const record = await readAttempt(attempts, input.attempt.id);
        if (!record) throw new StorageError('NOT_FOUND');
        const timestamp = now();
        assertWriter(record, input.lease, timestamp);
        if (input.expectedRevision !== record.attempt.revision
          || input.attempt.revision !== input.expectedRevision + 1) {
          throw new StorageError('STALE_REVISION');
        }
        checkEmbeddedVersion(input.attempt, record.contentVersion);
        if (input.attempt.cycleId !== record.attempt.cycleId) throw new StorageError('CORRUPT');
        const current = await readCycle(cycles, record.attempt.cycleId);
        if (!current || current.contentVersion !== record.contentVersion) throw new StorageError('CORRUPT');
        checkPair(record.attempt, current.cycle);
        if (input.cycleUpdate) {
          const { cycle, expectedRevision } = input.cycleUpdate;
          checkCycle<C>(cycle, options.validateCycle);
          checkEmbeddedVersion(cycle, record.contentVersion);
          if (cycle.id !== record.attempt.cycleId) throw new StorageError('CYCLE_CONFLICT');
          if (current.revision !== expectedRevision) throw new StorageError('CYCLE_CONFLICT');
          await requestResult(cycles.put({ ...current, cycle, revision: nextRevision(current.revision) }));
        }
        checkPair(input.attempt, input.cycleUpdate?.cycle ?? current.cycle);
        const renewedLease = issueLease(input.lease.writerId, input.lease.token, timestamp);
        await requestResult(attempts.put({ ...record, attempt: input.attempt, lease: renewedLease }));
        const persisted = await readAttempt(attempts, record.id);
        if (!persisted) throw new StorageError('CORRUPT');
        return persisted.attempt;
      });
    },

    releaseWriter(attemptId, lease) {
      return run('readwrite', async (attempts) => {
        const record = await readAttempt(attempts, attemptId);
        if (!record) throw new StorageError('NOT_FOUND');
        assertWriter(record, lease, now());
        await requestResult(attempts.put({ ...record, lease: null }));
      });
    },

    close() {
      closed = true;
    },
  };
}
