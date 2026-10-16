/**
 * Conflict-aware offline / multi-tab operation queue.
 *
 * Problem this solves: a user makes changes while offline, or has several tabs
 * open, and a refresh (or a disconnect) silently drops the work — or worse,
 * two tabs replay the same operation and clobber each other's state.
 *
 * Design notes:
 * - Every operation is stored under its own localStorage key
 *   (`eduvault:operation-queue:v1:<id>`), so two tabs writing two different
 *   operations never overwrite each other's storage — a single JSON blob per
 *   tab would.
 * - Each operation carries an optional `baseVersion`, the state version the
 *   caller observed when it enqueued the work. Before replaying, `drain()`
 *   compares it with the observed current version (via `versionProvider`); a
 *   mismatch turns the operation into `conflict` state instead of silently
 *   applying stale writes, and the caller must resolve it explicitly with
 *   `retry` (rebase) or `discard`.
 * - Execution uses a short-lived per-operation lease (`owner` tab id +
 *   `expiresAt`), so only one tab replays a given operation at a time. If the
 *   owning tab dies mid-flight the lease expires and another tab can reclaim.
 * - Failures are classified deterministically:
 *     * `OperationConflictError` (or a thrown object with `conflict`)  → conflict
 *     * `OperationTerminalError` (or `retryable: false`)               → failed
 *     * anything else / `OperationRetryableError`                      → retry_scheduled
 *       with exponential backoff + jitter, until `maxAttempts`, then `failed`.
 * - Terminal work is never deleted implicitly; `clearCompleted()` is the
 *   explicit purge so UIs can show "applied" results after a refresh.
 *
 * The queue is transport-agnostic: `enqueue`/`drain({ handler })` accept any
 * async handler. It has no React dependency so it can be unit-tested in plain
 * Node, and no fetch calls of its own.
 */

export const OPERATION_QUEUE_STORAGE_PREFIX = "eduvault:operation-queue:v1:";
export const OPERATION_QUEUE_CHANNEL = "eduvault:operation-queue";

export const OPERATION_STATUS = Object.freeze({
  PENDING: "pending",
  IN_FLIGHT: "in_flight",
  RETRY_SCHEDULED: "retry_scheduled",
  CONFLICT: "conflict",
  FAILED: "failed",
  DISCARDED: "discarded",
  APPLIED: "applied",
});

export const TERMINAL_OPERATION_STATUSES = Object.freeze([
  OPERATION_STATUS.APPLIED,
  OPERATION_STATUS.FAILED,
  OPERATION_STATUS.DISCARDED,
]);

export const OPEN_OPERATION_STATUSES = Object.freeze([
  OPERATION_STATUS.PENDING,
  OPERATION_STATUS.IN_FLIGHT,
  OPERATION_STATUS.RETRY_SCHEDULED,
  OPERATION_STATUS.CONFLICT,
]);

export const DEFAULT_QUEUE_CONFIG = Object.freeze({
  maxAttempts: 5,
  initialBackoffMs: 1000,
  maxBackoffMs: 60_000,
  backoffMultiplier: 2,
  jitterFraction: 0.2,
  leaseTtlMs: 30_000,
  maxTrackedOperations: 200,
  retentionTerminalLimit: 20,
});

export const CONFLICT_RESOLUTIONS = Object.freeze({
  RETRY: "retry",
  DISCARD: "discard",
});

/** Base error for deterministic failure classification. */
export class OperationError extends Error {
  constructor(message, { code = "operation_error", retryable = false, dependency = null } = {}) {
    super(message);
    this.name = "OperationError";
    this.code = code;
    this.retryable = retryable;
    this.dependency = dependency;
  }
}

/** The remote state changed since the operation was enqueued. */
export class OperationConflictError extends OperationError {
  constructor(message, { expectedVersion = null, actualVersion = null, remoteState = null } = {}) {
    super(message, { code: "operation_conflict", retryable: false });
    this.name = "OperationConflictError";
    this.conflict = {
      type: "stale_state",
      message: String(message || "Remote state changed since this operation was queued."),
      expectedVersion,
      actualVersion,
      remoteState,
      detectedAt: new Date().toISOString(),
    };
  }
}

/** A failure worth retrying (network down, 5xx, connection reset). */
export class OperationRetryableError extends OperationError {
  constructor(message, { code = "operation_retryable", dependency = null } = {}) {
    super(message, { code, retryable: true, dependency });
    this.name = "OperationRetryableError";
  }
}

/** A failure that will never succeed by retrying (validation, 4xx, expired quote). */
export class OperationTerminalError extends OperationError {
  constructor(message, { code = "operation_terminal", dependency = null } = {}) {
    super(message, { code, retryable: false, dependency });
    this.name = "OperationTerminalError";
  }
}

function defaultRandom() {
  return Math.random();
}

function defaultIdFactory() {
  const cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `op-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * Deterministic exponential backoff with jitter. `random` is injectable so
 * tests can pin the schedule (issue: retry timing must be reproducible).
 */
export function computeBackoffMs(attempts, config = DEFAULT_QUEUE_CONFIG, random = defaultRandom) {
  const { initialBackoffMs, maxBackoffMs, backoffMultiplier, jitterFraction } = { ...DEFAULT_QUEUE_CONFIG, ...config };
  const safeAttempts = Math.max(1, Number(attempts) || 1);
  const exponential = initialBackoffMs * Math.pow(backoffMultiplier, safeAttempts - 1);
  const capped = Math.min(exponential, maxBackoffMs);
  const jitter = capped * jitterFraction * random();
  return Math.round(capped + jitter);
}

/**
 * Deterministic failure classification used by `fail()`.
 * Returns one of: "conflict" | "terminal" | "retryable".
 */
export function classifyOperationFailure(error) {
  if (error instanceof OperationConflictError) return "conflict";
  if (error?.conflict) return "conflict";
  if (error instanceof OperationTerminalError) return "terminal";
  if (error instanceof OperationRetryableError) return "retryable";
  if (error?.retryable === false) return "terminal";
  // Unknown failures (network blips, handler bugs) are retried a bounded
  // number of times rather than dropped; `maxAttempts` keeps that bounded.
  return "retryable";
}

function isTerminalStatus(status) {
  return TERMINAL_OPERATION_STATUSES.includes(status);
}

function sanitizeJson(value, fallback = null) {
  if (value === undefined) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function normalizeStoredOperation(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || typeof raw.type !== "string") return null;
  if (!OPEN_OPERATION_STATUSES.includes(raw.status) && !TERMINAL_OPERATION_STATUSES.includes(raw.status)) {
    return null;
  }
  return {
    id: raw.id,
    type: raw.type,
    payload: raw.payload && typeof raw.payload === "object" ? raw.payload : {},
    meta: raw.meta && typeof raw.meta === "object" ? raw.meta : null,
    dedupeKey: typeof raw.dedupeKey === "string" ? raw.dedupeKey : null,
    status: raw.status,
    attempts: Number.isSafeInteger(raw.attempts) ? raw.attempts : 0,
    maxAttempts: Number.isSafeInteger(raw.maxAttempts) && raw.maxAttempts > 0 ? raw.maxAttempts : DEFAULT_QUEUE_CONFIG.maxAttempts,
    baseVersion: raw.baseVersion ?? null,
    nextAttemptAt: Number.isFinite(raw.nextAttemptAt) ? raw.nextAttemptAt : 0,
    lease: raw.lease && typeof raw.lease === "object" ? raw.lease : null,
    lastError: raw.lastError || null,
    conflict: raw.conflict || null,
    result: raw.result ?? null,
    enqueuedAt: Number.isFinite(raw.enqueuedAt) ? raw.enqueuedAt : 0,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    completedAt: Number.isFinite(raw.completedAt) ? raw.completedAt : null,
    discardedAt: Number.isFinite(raw.discardedAt) ? raw.discardedAt : null,
    discardReason: raw.discardReason || null,
  };
}

function describeError(error) {
  if (!error) return null;
  return {
    name: error.name || "Error",
    message: String(error.message || error).slice(0, 500),
    code: error.code || null,
    retryable: error.retryable ?? null,
    dependency: error.dependency || null,
  };
}

/**
 * @param {object} [options]
 * @param {Storage} [options.storage]    Inject for SSR/tests; defaults to window.localStorage.
 * @param {() => number} [options.now]   Clock injection.
 * @param {() => number} [options.random] Random source for jitter.
 * @param {() => string} [options.idFactory]
 * @param {string} [options.tabId]       Stable id for this tab; leases are keyed by it.
 * @param {BroadcastChannel|{postMessage: Function, close?: Function}} [options.broadcast]
 * @param {boolean} [options.disableBroadcast]
 * @param {Function} [options.onChange]
 */
export function createOperationQueue(options = {}) {
  const config = { ...DEFAULT_QUEUE_CONFIG, ...(options.config || {}) };
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const random = typeof options.random === "function" ? options.random : defaultRandom;
  const idFactory = typeof options.idFactory === "function" ? options.idFactory : defaultIdFactory;
  const tabId = options.tabId || idFactory();

  const storage =
    options.storage ||
    (typeof window !== "undefined" ? window.localStorage : undefined) ||
    null;

  let broadcast = options.broadcast || null;
  if (!broadcast && !options.disableBroadcast && typeof BroadcastChannel !== "undefined") {
    try {
      broadcast = new BroadcastChannel(OPERATION_QUEUE_CHANNEL);
    } catch {
      broadcast = null;
    }
  }

  const listeners = new Set();
  let snapshot = readAllOperations();
  let fingerprint = JSON.stringify(snapshot);

  function readOperationKeys() {
    if (!storage) return [];
    const keys = [];
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (typeof key === "string" && key.startsWith(OPERATION_QUEUE_STORAGE_PREFIX)) keys.push(key);
      }
    } catch {
      return [];
    }
    return keys;
  }

  function readAllOperations() {
    const operations = [];
    for (const key of readOperationKeys()) {
      try {
        const raw = storage.getItem(key);
        if (!raw) continue;
        const op = normalizeStoredOperation(JSON.parse(raw));
        if (op) operations.push(op);
      } catch {
        // Corrupt row: ignore it rather than poisoning the whole queue.
      }
    }
    return operations.sort((a, b) => a.enqueuedAt - b.enqueuedAt || (a.id < b.id ? -1 : 1));
  }

  function notifyOthers() {
    if (!broadcast) return;
    try {
      broadcast.postMessage({ type: "operation-queue:changed", tabId, at: now() });
    } catch {
      // A closed/blocked channel must never break a mutation.
    }
  }

  function emit({ broadcast: shouldBroadcast = true } = {}) {
    snapshot = readAllOperations();
    const nextFingerprint = JSON.stringify(snapshot);
    const changed = nextFingerprint !== fingerprint;
    fingerprint = nextFingerprint;
    if (changed) {
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // A broken subscriber must not break queue bookkeeping.
        }
      }
    }
    if (shouldBroadcast) notifyOthers();
    return snapshot;
  }

  function persist(operation) {
    if (!storage) return;
    try {
      storage.setItem(OPERATION_QUEUE_STORAGE_PREFIX + operation.id, JSON.stringify(operation));
    } catch (error) {
      throw new OperationError("Operation queue storage is unavailable (quota or private mode).", {
        code: "queue_storage_unavailable",
        retryable: false,
        dependency: "local-storage",
      });
    }
  }

  function removePersisted(id) {
    if (!storage) return;
    try {
      storage.removeItem(OPERATION_QUEUE_STORAGE_PREFIX + id);
    } catch {
      // Best effort; the row will be ignored if it cannot be removed.
    }
  }

  function get(id) {
    return readAllOperations().find((op) => op.id === id) || null;
  }

  function isLeaseExpired(op, at) {
    if (!op.lease) return true;
    if (op.lease.owner === tabId) return true;
    return !(op.lease.expiresAt > at);
  }

  function isReady(op, at) {
    if (op.status === OPERATION_STATUS.PENDING || op.status === OPERATION_STATUS.RETRY_SCHEDULED) {
      return op.nextAttemptAt <= at && isLeaseExpired(op, at);
    }
    if (op.status === OPERATION_STATUS.IN_FLIGHT) {
      // Reclaim work whose owner died mid-flight.
      return !!op.lease && op.lease.owner !== tabId && !(op.lease.expiresAt > at);
    }
    return false;
  }

  function enforceRetention(operations) {
    const terminal = operations
      .filter((op) => isTerminalStatus(op.status))
      .sort((a, b) => (b.completedAt || b.discardedAt || b.updatedAt) - (a.completedAt || a.discardedAt || a.updatedAt));
    const kept = new Set(terminal.slice(0, config.retentionTerminalLimit).map((op) => op.id));
    for (const op of terminal) {
      if (!kept.has(op.id)) removePersisted(op.id);
    }
  }

  const queue = {
    tabId,
    config,

    getSnapshot() {
      if (fingerprint === "") {
        // First access (server render or a fresh tab): hydrate silently.
        // Mutations go through emit(), which is the only place listeners and
        // other tabs are notified.
        snapshot = readAllOperations();
        fingerprint = JSON.stringify(snapshot);
      }
      return snapshot;
    },

    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    list({ includeTerminal = true } = {}) {
      return queue.getSnapshot().filter((op) => includeTerminal || !isTerminalStatus(op.status));
    },

    get,

    openOperations(dedupeKey) {
      return queue
        .list({ includeTerminal: false })
        .filter((op) => (dedupeKey ? op.dedupeKey === dedupeKey : true));
    },

    counts() {
      const operations = queue.getSnapshot();
      return {
        total: operations.length,
        open: operations.filter((op) => !isTerminalStatus(op.status)).length,
        pending: operations.filter((op) => op.status === OPERATION_STATUS.PENDING).length,
        inFlight: operations.filter((op) => op.status === OPERATION_STATUS.IN_FLIGHT).length,
        retryScheduled: operations.filter((op) => op.status === OPERATION_STATUS.RETRY_SCHEDULED).length,
        conflicts: operations.filter((op) => op.status === OPERATION_STATUS.CONFLICT).length,
        failed: operations.filter((op) => op.status === OPERATION_STATUS.FAILED).length,
        applied: operations.filter((op) => op.status === OPERATION_STATUS.APPLIED).length,
        discarded: operations.filter((op) => op.status === OPERATION_STATUS.DISCARDED).length,
      };
    },

    enqueue({
      type,
      payload = {},
      meta = null,
      dedupeKey = null,
      baseVersion = null,
      maxAttempts = config.maxAttempts,
      at = now(),
    } = {}) {
      if (typeof type !== "string" || !type.trim()) {
        throw new OperationError("Operation type is required.", { code: "invalid_operation", retryable: false });
      }

      // Dedupe against open work only: once an operation is terminal a fresh
      // enqueue is a genuinely new user action and must be recorded.
      if (dedupeKey) {
        const existing = queue.openOperations(dedupeKey)[0];
        if (existing) return existing;
      }

      let operations = readAllOperations();
      enforceRetention(operations);
      operations = readAllOperations(); // evicted terminal rows no longer count

      if (operations.length >= config.maxTrackedOperations) {
        throw new OperationError(
          `Operation queue is full (${config.maxTrackedOperations} tracked operations). Resolve or clear completed work first.`,
          { code: "queue_capacity_exceeded", retryable: false },
        );
      }

      const operation = {
        id: idFactory(),
        type: type.trim(),
        payload: sanitizeJson(payload, {}) || {},
        meta: sanitizeJson(meta, null),
        dedupeKey: dedupeKey ? String(dedupeKey) : null,
        status: OPERATION_STATUS.PENDING,
        attempts: 0,
        maxAttempts: Number.isSafeInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : config.maxAttempts,
        baseVersion,
        nextAttemptAt: at,
        lease: null,
        lastError: null,
        conflict: null,
        result: null,
        enqueuedAt: at,
        updatedAt: at,
        completedAt: null,
        discardedAt: null,
        discardReason: null,
      };

      persist(operation);
      emit();
      return operation;
    },

    nextReady(at = now()) {
      return queue.getSnapshot().find((op) => isReady(op, at)) || null;
    },

    claim(id, at = now()) {
      const operation = get(id);
      if (!operation || !isReady(operation, at)) return null;

      const claimed = {
        ...operation,
        status: OPERATION_STATUS.IN_FLIGHT,
        lease: { owner: tabId, expiresAt: at + config.leaseTtlMs },
        updatedAt: at,
      };
      persist(claimed);
      emit();
      return claimed;
    },

    markApplied(id, { result = null, at = now() } = {}) {
      const operation = get(id);
      if (!operation) return null;
      const applied = {
        ...operation,
        status: OPERATION_STATUS.APPLIED,
        result: sanitizeJson(result, null),
        lease: null,
        lastError: null,
        updatedAt: at,
        completedAt: at,
      };
      persist(applied);
      emit();
      return applied;
    },

    markFailed(id, error, { at = now() } = {}) {
      const operation = get(id);
      if (!operation) return null;

      const kind = classifyOperationFailure(error);
      const attempts = operation.attempts + 1;
      const base = {
        ...operation,
        lease: null,
        attempts,
        updatedAt: at,
        lastError: describeError(error),
      };

      let failed;
      if (kind === "conflict") {
        failed = {
          ...base,
          status: OPERATION_STATUS.CONFLICT,
          conflict: sanitizeJson(
            error?.conflict || {
              type: "stale_state",
              message: String(error?.message || "Conflict reported by handler."),
            },
          ),
          nextAttemptAt: at,
        };
      } else if (kind === "terminal" || attempts >= operation.maxAttempts) {
        failed = { ...base, status: OPERATION_STATUS.FAILED, completedAt: at, nextAttemptAt: at };
      } else {
        failed = {
          ...base,
          status: OPERATION_STATUS.RETRY_SCHEDULED,
          nextAttemptAt: at + computeBackoffMs(attempts, config, random),
        };
      }

      persist(failed);
      emit();
      return failed;
    },

    /**
     * Deterministic conflict resolution. Returns the updated operation, or
     * null when the id is unknown or not in conflict state.
     *
     * - `retry`:  requeue, optionally rebasing to `baseVersion` so the next
     *             drain validates against the caller-refreshed version.
     * - `discard`: abandon the work. Callers use the returned operation's
     *             payload to roll back whatever optimistic UI they applied.
     */
    resolveConflict(id, resolution, { baseVersion, at = now() } = {}) {
      // Validate the choice first so programming errors surface even when the
      // operation is unknown or already resolved.
      if (resolution !== CONFLICT_RESOLUTIONS.RETRY && resolution !== CONFLICT_RESOLUTIONS.DISCARD) {
        throw new OperationError(`Unknown conflict resolution: ${resolution}`, {
          code: "unknown_conflict_resolution",
          retryable: false,
        });
      }

      const operation = get(id);
      if (!operation || operation.status !== OPERATION_STATUS.CONFLICT) return null;

      if (resolution === CONFLICT_RESOLUTIONS.RETRY) {
        const retried = {
          ...operation,
          status: OPERATION_STATUS.PENDING,
          baseVersion: baseVersion === undefined ? operation.baseVersion : baseVersion,
          conflict: null,
          nextAttemptAt: at,
          updatedAt: at,
        };
        persist(retried);
        emit();
        return retried;
      }

      if (resolution === CONFLICT_RESOLUTIONS.DISCARD) {
        const discarded = {
          ...operation,
          status: OPERATION_STATUS.DISCARDED,
          lease: null,
          discardReason: "conflict_discarded_by_user",
          discardedAt: at,
          updatedAt: at,
        };
        persist(discarded);
        emit();
        return discarded;
      }
    },

    clearCompleted({ at = now() } = {}) {
      const operations = queue.getSnapshot().filter((op) => isTerminalStatus(op.status));
      for (const op of operations) removePersisted(op.id);
      emit();
      return operations.length;
    },

    reset() {
      for (const key of readOperationKeys()) {
        try {
          storage?.removeItem(key);
        } catch {
          // ignore
        }
      }
      emit();
    },

    /** Re-read storage after another tab mutated it (`storage` event / broadcast). */
    refreshFromStorage() {
      return emit({ broadcast: false });
    },

    /**
     * Replay ready operations sequentially through `handler`.
     *
     * @param {object} params
     * @param {(operation: object) => Promise<any>} params.handler
     * @param {boolean|(() => boolean)} [params.online]
     * @param {(operation: object) => (any | Promise<any>)} [params.versionProvider]
     *   Returns the currently observed version for the operation's target.
     *   A mismatch with `operation.baseVersion` raises a conflict without
     *   executing the handler. A throwing provider is treated as *retryable*
     *   (we could not prove the state is fresh, so we do not apply stale work).
     * @param {(at: number) => number} [params.at]  Timestamp source for this drain pass.
     */
    async drain({ handler, online = true, versionProvider = null, at = null } = {}) {
      const summary = { online: true, processed: 0, applied: 0, retried: 0, conflicts: 0, failed: 0, skipped: 0 };
      const onlineNow = typeof online === "function" ? online : () => online !== false;
      const timestamp = typeof at === "function" ? at : () => (typeof at === "number" ? at : now());

      if (typeof handler !== "function") {
        throw new OperationError("drain() requires a handler function.", { code: "invalid_handler", retryable: false });
      }
      if (!onlineNow()) {
        summary.online = false;
        return summary;
      }

      // Snapshot the candidate ids up front; new work enqueued mid-drain is
      // picked up by the next pass (bounded work per drain = predictable UI).
      const candidates = queue
        .getSnapshot()
        .filter((op) => isReady(op, timestamp()))
        .map((op) => op.id);

      for (const id of candidates) {
        if (!onlineNow()) {
          summary.online = false;
          break;
        }

        const current = get(id);
        if (!current || !isReady(current, timestamp())) {
          summary.skipped += 1;
          continue;
        }

        if (versionProvider && current.baseVersion !== null && current.baseVersion !== undefined) {
          let observed;
          try {
            observed = await versionProvider(current);
          } catch (error) {
            queue.markFailed(id, new OperationRetryableError(`Could not verify state freshness: ${error?.message || error}`, { code: "version_probe_failed" }), { at: timestamp() });
            summary.retried += 1;
            continue;
          }
          if (observed !== current.baseVersion) {
            queue.markFailed(
              id,
              new OperationConflictError("This item changed in another tab or session since you queued the change.", {
                expectedVersion: current.baseVersion,
                actualVersion: observed,
              }),
              { at: timestamp() },
            );
            summary.conflicts += 1;
            continue;
          }
        }

        const claimed = queue.claim(id, timestamp());
        if (!claimed) {
          // Another tab won the lease; deterministic skip, not an error.
          summary.skipped += 1;
          continue;
        }

        summary.processed += 1;
        try {
          const result = await handler(claimed);
          queue.markApplied(id, { result, at: timestamp() });
          summary.applied += 1;
        } catch (error) {
          const updated = queue.markFailed(id, error, { at: timestamp() });
          if (updated?.status === OPERATION_STATUS.CONFLICT) summary.conflicts += 1;
          else if (updated?.status === OPERATION_STATUS.FAILED) summary.failed += 1;
          else summary.retried += 1;
        }
      }

      return summary;
    },

    /** Release this tab's resources (BroadcastChannel). Storage rows stay. */
    close() {
      listeners.clear();
      try {
        broadcast?.close?.();
      } catch {
        // ignore
      }
      broadcast = null;
    },
  };

  return queue;
}
