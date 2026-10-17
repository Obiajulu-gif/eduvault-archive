/**
 * src/lib/sideEffects/dispatcher.js
 *
 * Idempotent side-effect dispatcher with replay and dead-letter recovery (#945).
 *
 * The existing outbox (src/lib/backend/outbox.js) guarantees an intent is
 * eventually *attempted*, but the unit of retry is the whole intent: a
 * webhook fan-out that reaches 2 of 3 URLs re-sends to all 3 on retry, an
 * operator replay of a dead letter re-runs work that already landed, and
 * every error is retried the same way whether or not it can ever succeed.
 *
 * This dispatcher makes side effects:
 *
 *   - keyed:       every effect has a caller-supplied idempotency key; a
 *                  second dispatch with the same key returns the stored
 *                  outcome instead of re-running the handler, and reusing a
 *                  key with a different payload is rejected.
 *   - step-scoped: handlers wrap each user-visible action in `ctx.step(id, fn)`.
 *                  A completed step is recorded and never re-executed by a
 *                  retry, a lease takeover, or a dead-letter replay.
 *   - retryable:   transient failures back off exponentially; errors marked
 *                  permanent (`retryable === false`) dead-letter immediately.
 *   - fenced:      execution holds a lease; a worker whose lease expired (and
 *                  was taken over) cannot overwrite the new owner's outcome.
 *   - observable:  every transition is appended to the record history and
 *                  emitted through `onEvent`; `stats()` gives status counts.
 *   - recoverable: `replayDeadLetter` re-queues an effect with an audited
 *                  operator + reason, preserving completed steps.
 *
 * Storage is pluggable. `createMemorySideEffectStore` is the reference
 * implementation and documents the atomicity each method must provide; see
 * docs/side-effect-dispatcher.md for the MongoDB mapping and rollout plan.
 */

import crypto from 'node:crypto';

export const EffectStatus = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  RETRY_SCHEDULED: 'retry_scheduled',
  SUCCEEDED: 'succeeded',
  DEAD_LETTER: 'dead_letter',
});

export const DEFAULT_DISPATCHER_CONFIG = Object.freeze({
  maxAttempts: 5,
  leaseMs: 60_000,
  initialBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  backoffMultiplier: 2,
  maxHistory: 50,
});

const KEY_PATTERN = /^[A-Za-z0-9:._\-/]{1,200}$/;

export class IdempotencyConflictError extends Error {
  constructor(key) {
    super(`Idempotency key "${key}" was already used with a different type or payload.`);
    this.name = 'IdempotencyConflictError';
    this.code = 'IDEMPOTENCY_CONFLICT';
    this.key = key;
  }
}

/** Throw from a handler for failures that will never succeed on retry. */
export class PermanentSideEffectError extends Error {
  constructor(message, code = 'PERMANENT_FAILURE') {
    super(message);
    this.name = 'PermanentSideEffectError';
    this.code = code;
    this.retryable = false;
  }
}

function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(',')}}`;
}

export function hashPayload(type, payload) {
  return crypto.createHash('sha256').update(`${type}|${stableStringify(payload ?? null)}`).digest('hex');
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function describeError(error) {
  return {
    name: error?.name || 'Error',
    code: error?.code ?? null,
    message: String(error?.message ?? error).slice(0, 500),
    retryable: error?.retryable !== false,
  };
}

/**
 * In-memory store. Each method is synchronous internally, so every
 * read-check-write below is atomic with respect to other callers in the
 * same process — the same guarantee a database store must give per method
 * (e.g. MongoDB `findOneAndUpdate` with the conditions in the filter).
 */
export function createMemorySideEffectStore() {
  const records = new Map();

  const claimable = (record, now) =>
    ((record.status === EffectStatus.PENDING || record.status === EffectStatus.RETRY_SCHEDULED) &&
      record.nextAttemptAt <= now) ||
    (record.status === EffectStatus.IN_PROGRESS && record.leaseExpiresAt <= now);

  return {
    async insertIfAbsent(record) {
      const existing = records.get(record.key);
      if (existing) return { inserted: false, record: clone(existing) };
      records.set(record.key, clone(record));
      return { inserted: true, record: clone(record) };
    },

    async get(key) {
      return clone(records.get(key) ?? null);
    },

    /** Atomically take the lease if the record is due or its lease expired. */
    async claim(key, { owner, now, leaseUntil }) {
      const record = records.get(key);
      if (!record || !claimable(record, now)) return null;
      record.status = EffectStatus.IN_PROGRESS;
      record.leaseOwner = owner;
      record.leaseExpiresAt = leaseUntil;
      record.attempts += 1;
      record.updatedAt = now;
      return clone(record);
    },

    /** Apply `patch` only while `owner` still holds the lease (fencing). */
    async updateIfOwner(key, owner, patch) {
      const record = records.get(key);
      if (!record || record.status !== EffectStatus.IN_PROGRESS || record.leaseOwner !== owner) return null;
      Object.assign(record, clone(patch));
      return clone(record);
    },

    /** Apply `patch` only when the record is in `expectedStatus`. */
    async updateIfStatus(key, expectedStatus, patch) {
      const record = records.get(key);
      if (!record || record.status !== expectedStatus) return null;
      Object.assign(record, clone(patch));
      return clone(record);
    },

    /** Record a completed step; first writer wins. Requires the lease. */
    async recordStep(key, owner, stepId, step) {
      const record = records.get(key);
      if (!record || record.leaseOwner !== owner || record.status !== EffectStatus.IN_PROGRESS) return null;
      if (!record.steps[stepId]) record.steps[stepId] = clone(step);
      return clone(record.steps[stepId]);
    },

    async listDue(now, limit) {
      return [...records.values()]
        .filter((record) => claimable(record, now))
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
        .slice(0, limit)
        .map(clone);
    },

    async listByStatus(status, limit = 100) {
      return [...records.values()].filter((r) => r.status === status).slice(0, limit).map(clone);
    },

    async countByStatus() {
      const counts = Object.fromEntries(Object.values(EffectStatus).map((s) => [s, 0]));
      for (const record of records.values()) counts[record.status] += 1;
      return counts;
    },
  };
}

/**
 * @param {object} options
 * @param {Record<string, (ctx) => Promise<any>>} options.handlers  Keyed by effect type.
 * @param {object} [options.store]       Defaults to an in-memory store.
 * @param {string} [options.workerId]
 * @param {() => Date} [options.clock]
 * @param {(event) => void} [options.onEvent]  Observability hook; must not throw.
 * @param {object} [options.config]
 */
export function createSideEffectDispatcher({
  handlers,
  store = createMemorySideEffectStore(),
  workerId = `dispatcher-${crypto.randomUUID()}`,
  clock = () => new Date(),
  onEvent = () => {},
  config = {},
} = {}) {
  if (!handlers || typeof handlers !== 'object') {
    throw new TypeError('createSideEffectDispatcher requires a handlers map.');
  }
  const cfg = { ...DEFAULT_DISPATCHER_CONFIG, ...config };

  const emit = (event, record, detail = {}) => {
    try {
      onEvent({
        event,
        key: record?.key ?? null,
        type: record?.type ?? null,
        status: record?.status ?? null,
        attempts: record?.attempts ?? 0,
        workerId,
        at: clock().toISOString(),
        ...detail,
      });
    } catch {
      // Observability must never change dispatch outcomes.
    }
  };

  const historyEntry = (record, event, detail) => {
    const history = [...(record.history || []), { at: clock(), event, workerId, ...detail }];
    return history.slice(-cfg.maxHistory);
  };

  const backoffMs = (attempts) =>
    Math.min(cfg.initialBackoffMs * Math.pow(cfg.backoffMultiplier, Math.max(0, attempts - 1)), cfg.maxBackoffMs);

  async function enqueue({ key, type, payload = null }) {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      throw new TypeError('Side effect key must be 1-200 chars of [A-Za-z0-9:._-/].');
    }
    if (typeof handlers[type] !== 'function') {
      throw new TypeError(`No handler registered for side effect type "${type}".`);
    }
    const now = clock();
    const payloadHash = hashPayload(type, payload);
    const { inserted, record } = await store.insertIfAbsent({
      key,
      type,
      payload: clone(payload),
      payloadHash,
      status: EffectStatus.PENDING,
      attempts: 0,
      nextAttemptAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      result: null,
      steps: {},
      replayCount: 0,
      history: [{ at: now, event: 'enqueued', workerId }],
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    if (!inserted && record.payloadHash !== payloadHash) {
      emit('idempotency_conflict', record);
      throw new IdempotencyConflictError(key);
    }
    if (inserted) emit('enqueued', record);
    return { inserted, record };
  }

  async function execute(key) {
    const now = clock();
    const claimed = await store.claim(key, {
      owner: workerId,
      now,
      leaseUntil: new Date(now.getTime() + cfg.leaseMs),
    });
    if (!claimed) return null;
    emit('attempt_started', claimed);

    const ctx = {
      key: claimed.key,
      type: claimed.type,
      payload: clone(claimed.payload),
      attempt: claimed.attempts,
      /** Idempotency key to forward to downstream providers for a step. */
      idempotencyKey: (stepId) => `${claimed.key}:${stepId}`,
      async step(stepId, fn) {
        const done = claimed.steps[stepId];
        if (done) {
          emit('step_skipped', claimed, { stepId });
          return clone(done.result);
        }
        // Re-check the lease before a user-visible action so a worker that
        // stalled past its lease cannot act after another worker took over.
        // The window between this check and `fn` is closed downstream by
        // forwarding the step idempotency key to the provider.
        const current = await store.get(claimed.key);
        if (!current || current.leaseOwner !== workerId || current.leaseExpiresAt <= clock()) {
          const error = new Error(`Lease lost before step "${stepId}".`);
          error.code = 'LEASE_LOST';
          throw error;
        }
        const result = await fn(`${claimed.key}:${stepId}`);
        const stored = await store.recordStep(claimed.key, workerId, stepId, {
          completedAt: clock(),
          result: result ?? null,
        });
        if (!stored) {
          // Lease lost mid-handler: the action already ran, so surface it
          // instead of silently continuing under someone else's lease.
          const error = new Error(`Lease lost while recording step "${stepId}".`);
          error.code = 'LEASE_LOST';
          throw error;
        }
        claimed.steps[stepId] = stored;
        emit('step_completed', claimed, { stepId });
        return clone(stored.result);
      },
    };

    let outcome;
    try {
      const result = await handlers[claimed.type](ctx);
      const at = clock();
      outcome = await store.updateIfOwner(key, workerId, {
        status: EffectStatus.SUCCEEDED,
        result: result ?? null,
        lastError: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: at,
        updatedAt: at,
        history: historyEntry(claimed, 'succeeded', { attempt: claimed.attempts }),
      });
      if (outcome) emit('succeeded', outcome);
    } catch (error) {
      const at = clock();
      const lastError = describeError(error);
      const exhausted = claimed.attempts >= cfg.maxAttempts;
      const dead = !lastError.retryable || exhausted;
      outcome = await store.updateIfOwner(key, workerId, {
        status: dead ? EffectStatus.DEAD_LETTER : EffectStatus.RETRY_SCHEDULED,
        lastError,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: dead ? at : new Date(at.getTime() + backoffMs(claimed.attempts)),
        updatedAt: at,
        history: historyEntry(claimed, dead ? 'dead_lettered' : 'retry_scheduled', {
          attempt: claimed.attempts,
          error: lastError.message,
          reason: dead ? (lastError.retryable ? 'max_attempts_exceeded' : 'permanent_error') : undefined,
        }),
      });
      if (outcome) emit(dead ? 'dead_lettered' : 'retry_scheduled', outcome, { error: lastError });
    }

    if (!outcome) {
      emit('lease_lost', claimed);
      return { leaseLost: true, record: await store.get(key) };
    }
    return { leaseLost: false, record: outcome };
  }

  function summarize(record, { duplicate = false, executed = false } = {}) {
    return { status: record.status, duplicate, executed, result: clone(record.result), record };
  }

  /**
   * Enqueue and attempt immediately. Returns the stored outcome for a
   * duplicate key without invoking the handler again.
   */
  async function dispatch(effect) {
    const { inserted, record } = await enqueue(effect);
    if (!inserted && record.status === EffectStatus.SUCCEEDED) {
      emit('duplicate_suppressed', record);
      return summarize(record, { duplicate: true });
    }
    const ran = await execute(effect.key);
    if (!ran) {
      const current = await store.get(effect.key);
      if (!inserted) emit('duplicate_suppressed', current);
      return summarize(current, { duplicate: !inserted });
    }
    return summarize(ran.record, { duplicate: !inserted, executed: true });
  }

  /** Run effects that are due (scheduled retries, expired leases). */
  async function processDue({ limit = 25 } = {}) {
    const due = await store.listDue(clock(), limit);
    const results = [];
    for (const record of due) {
      const ran = await execute(record.key);
      if (ran) results.push(summarize(ran.record, { executed: true }));
    }
    return results;
  }

  /**
   * Operator recovery: move a dead letter back to pending. Completed steps are
   * kept, so already-delivered actions are not repeated.
   */
  async function replayDeadLetter(key, { operator, reason, runNow = true } = {}) {
    if (typeof operator !== 'string' || !operator.trim()) {
      throw new TypeError('replayDeadLetter requires an operator identity for audit.');
    }
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new TypeError('replayDeadLetter requires a reason for audit.');
    }
    const current = await store.get(key);
    if (!current) return { outcome: 'not_found' };
    if (current.status !== EffectStatus.DEAD_LETTER) return { outcome: 'not_dead_letter', record: current };

    const at = clock();
    const replayed = await store.updateIfStatus(key, EffectStatus.DEAD_LETTER, {
      status: EffectStatus.PENDING,
      attempts: 0,
      nextAttemptAt: at,
      replayCount: (current.replayCount || 0) + 1,
      updatedAt: at,
      history: historyEntry(current, 'replayed', { operator, reason, previousError: current.lastError?.message }),
    });
    if (!replayed) return { outcome: 'conflict', record: await store.get(key) };
    emit('replayed', replayed, { operator, reason });

    if (!runNow) return { outcome: 'requeued', record: replayed };
    const ran = await execute(key);
    return { outcome: 'replayed', record: ran ? ran.record : await store.get(key) };
  }

  async function stats() {
    return store.countByStatus();
  }

  return {
    workerId,
    enqueue,
    dispatch,
    processDue,
    replayDeadLetter,
    stats,
    getRecord: (key) => store.get(key),
    listDeadLetters: (limit) => store.listByStatus(EffectStatus.DEAD_LETTER, limit),
  };
}
