import { auditLog } from '@/lib/api/audit';
import { appendAuditRecord } from '@/lib/backend/auditLedger';
import { COLLECTIONS } from '@/lib/backend/schemaContracts';

/**
 * Deterministic recovery workflow for stuck pending actions (Issue #828).
 *
 * A "pending action" is any deferred side effect the app has accepted but not
 * yet completed (a checkout confirmation, an index write, a delivery job, …).
 * Historically these could sit in `pending` forever with no way for a user or
 * maintainer to see or resolve them. This module gives them an explicit,
 * deterministic state machine plus the two things operators need: visibility
 * (stale diagnostics) and an audit trail.
 *
 * States
 *   pending            — accepted, not yet attempted / first attempt in flight
 *   retryable          — a previous attempt failed but the retry budget remains
 *   failed             — retries exhausted (or permanently unrecoverable)
 *   resolved           — an automatic retry (or the user) completed the action
 *   manually_reviewed  — a maintainer resolved it out-of-band with a reason
 *
 * Allowed transitions (everything else throws PendingActionTransitionError):
 *
 *        ┌──────────► resolved ◄──────────┐
 *        │               ▲                │
 *   pending ──► retryable ─┘                │
 *        │          │                      │
 *        └──────────┴──► failed ───────────┘
 *        │                                 │
 *        └──────────► manually_reviewed ◄──┘
 *
 * `resolved` and `manually_reviewed` are terminal.
 *
 * The machine is pure: every action takes a record and returns a *new* record
 * plus the audit entry. Persisting the returned record is the caller's job, so
 * the logic is fully deterministic and testable without a database. Every
 * transition emits an audit entry — by default through the existing console
 * `auditLog()` (src/lib/api/audit.js); pass `onAudit` for a custom sink, or
 * `createLedgerAuditSink({ db })` to append tamper-evident records to the
 * hash-chained audit ledger (src/lib/backend/auditLedger.js).
 */

export const PENDING_ACTION_STATES = Object.freeze({
  PENDING: 'pending',
  RETRYABLE: 'retryable',
  FAILED: 'failed',
  RESOLVED: 'resolved',
  MANUALLY_REVIEWED: 'manually_reviewed',
});

export const TERMINAL_STATES = Object.freeze([
  PENDING_ACTION_STATES.RESOLVED,
  PENDING_ACTION_STATES.MANUALLY_REVIEWED,
]);

export const NON_TERMINAL_STATES = Object.freeze([
  PENDING_ACTION_STATES.PENDING,
  PENDING_ACTION_STATES.RETRYABLE,
  PENDING_ACTION_STATES.FAILED,
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  [PENDING_ACTION_STATES.PENDING]: [
    PENDING_ACTION_STATES.RETRYABLE,
    PENDING_ACTION_STATES.FAILED,
    PENDING_ACTION_STATES.RESOLVED,
    PENDING_ACTION_STATES.MANUALLY_REVIEWED,
  ],
  [PENDING_ACTION_STATES.RETRYABLE]: [
    PENDING_ACTION_STATES.RETRYABLE,
    PENDING_ACTION_STATES.FAILED,
    PENDING_ACTION_STATES.RESOLVED,
    PENDING_ACTION_STATES.MANUALLY_REVIEWED,
  ],
  [PENDING_ACTION_STATES.FAILED]: [
    PENDING_ACTION_STATES.RETRYABLE,
    PENDING_ACTION_STATES.RESOLVED,
    PENDING_ACTION_STATES.MANUALLY_REVIEWED,
  ],
  [PENDING_ACTION_STATES.RESOLVED]: [],
  [PENDING_ACTION_STATES.MANUALLY_REVIEWED]: [],
});

export const DEFAULT_PENDING_STALE_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Stale threshold, overridable with `PENDING_STALE_MS`. Resolved at import. */
export const PENDING_STALE_MS = resolveStaleThresholdMs();
/** Retry budget, overridable with `PENDING_ACTION_MAX_ATTEMPTS`. */
export const PENDING_ACTION_MAX_ATTEMPTS = resolveMaxAttempts();

export class PendingActionTransitionError extends Error {
  constructor(from, to) {
    super(`Illegal pending-action transition: ${from} -> ${to}`);
    this.name = 'PendingActionTransitionError';
    this.from = from;
    this.to = to;
  }
}

// ── Config ──────────────────────────────────────────────────────────────────

export function resolveStaleThresholdMs(env = process.env) {
  const parsed = Number(env?.PENDING_STALE_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PENDING_STALE_MS;
}

export function resolveMaxAttempts(env = process.env) {
  const parsed = Number(env?.PENDING_ACTION_MAX_ATTEMPTS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ATTEMPTS;
}

// ── Small deterministic helpers ─────────────────────────────────────────────

function toMs(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function toISO(value) {
  const ms = toMs(value);
  return ms == null ? null : new Date(ms).toISOString();
}

function stateOf(action) {
  return action?.state || action?.status || PENDING_ACTION_STATES.PENDING;
}

function actionIdOf(action) {
  const raw = action?.id ?? action?._id ?? action?.actionId ?? null;
  return raw == null ? '' : String(raw);
}

export function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from, to) {
  return Boolean(ALLOWED_TRANSITIONS[from]?.includes(to));
}

// ── Classification / diagnostics ────────────────────────────────────────────

/**
 * Derive a safe, presentation-ready classification of a pending action.
 * Deliberately returns only non-sensitive fields — never the action payload,
 * actor identity, or any credential — so it is safe to expose via diagnostics.
 *
 * @param {object} action
 * @param {{ now?: Date|number|string, staleThresholdMs?: number }} [options]
 */
export function classify(action, { now = new Date(), staleThresholdMs } = {}) {
  const state = stateOf(action);
  const threshold = Number.isFinite(staleThresholdMs) && staleThresholdMs > 0
    ? staleThresholdMs
    : PENDING_STALE_MS;
  const createdAt = toMs(action?.createdAt ?? action?.pendingSince ?? action?.updatedAt);
  const nowMs = toMs(now);

  const ageMs = createdAt == null || nowMs == null ? null : Math.max(0, nowMs - createdAt);
  const terminal = isTerminal(state);

  return {
    id: actionIdOf(action),
    type: action?.type ?? null,
    state,
    attempts: Number(action?.attempts || 0),
    createdAt: toISO(createdAt),
    lastAttemptAt: toISO(action?.lastAttemptAt),
    ageMs,
    stale: !terminal && ageMs != null && ageMs >= threshold,
    terminal,
    thresholdMs: threshold,
  };
}

async function loadRecords(source, options = {}) {
  if (!source) return [];
  if (Array.isArray(source)) return source;
  if (source instanceof Map) return Array.from(source.values());
  if (Array.isArray(source.records)) return source.records;

  const query = {
    $or: [
      { state: { $in: NON_TERMINAL_STATES } },
      { status: { $in: NON_TERMINAL_STATES } },
    ],
  };

  if (typeof source.collection === 'function') {
    const collection = source.collection(options.collection || COLLECTIONS.pendingActions);
    return collection.find(query).toArray();
  }
  if (typeof source.find === 'function') {
    return source.find(query).toArray();
  }
  return [];
}

/**
 * Return the non-terminal pending actions that have aged past the configured
 * threshold, newest-stale first, each as a sanitized `classify()` summary.
 *
 * @param {Array|Map|{records: Array}|import('mongodb').Db|object} source
 * @param {{ now?, threshold?, staleThresholdMs?, limit?, collection? }} [options]
 */
export async function listStalePending(source, options = {}) {
  const { now = new Date(), threshold, staleThresholdMs, limit } = options;
  const records = await loadRecords(source, options);
  const resolvedThreshold = threshold ?? staleThresholdMs;
  return records
    .map((record) => classify(record, { now, staleThresholdMs: resolvedThreshold }))
    .filter((summary) => summary.stale)
    .sort((a, b) => (b.ageMs ?? 0) - (a.ageMs ?? 0))
    .slice(0, Number.isInteger(limit) && limit > 0 ? limit : undefined);
}

// ── Audit ───────────────────────────────────────────────────────────────────

function defaultAuditSink(entry) {
  auditLog({
    event: entry.event,
    actor: entry.actor,
    status: entry.to,
    reason: entry.reason || undefined,
    correlationId: entry.actionId || undefined,
    materialId: entry.materialId || undefined,
  });
}

function buildAuditEntry({ action, from, to, actor, reason, now, attempt, extra = {} }) {
  return {
    event: 'pending_action_recovery',
    actionId: actionIdOf(action),
    actionType: action?.type ?? null,
    materialId: action?.materialId ?? null,
    actor: actor || 'system',
    from,
    to,
    outcome: extra.outcome ?? to,
    attempt: attempt ?? Number(action?.attempts || 0),
    reason: reason ?? null,
    error: extra.error ?? null,
    timestamp: toISO(now),
  };
}

function emitAudit(entry, onAudit) {
  if (typeof onAudit === 'function') return onAudit(entry);
  return defaultAuditSink(entry);
}

/**
 * Wrap the hash-chained audit ledger (src/lib/backend/auditLedger.js) as an
 * `onAudit` sink. Operation ids are deterministic, so replaying the same
 * transition is idempotent in the ledger.
 */
export function createLedgerAuditSink({ db, actor = 'system' } = {}) {
  if (!db) throw new TypeError('createLedgerAuditSink requires a db');
  return async function ledgerAuditSink(entry) {
    return appendAuditRecord({
      db,
      operationId: `${entry.actionId}:${entry.from}:${entry.to}:${entry.attempt}:${entry.timestamp}`,
      actor: entry.actor || actor,
      action: `pending_action.${entry.to}`,
      target: { type: 'pending_action', id: entry.actionId },
      reason: entry.reason,
      intent: { from: entry.from, to: entry.to, attempt: entry.attempt, actionType: entry.actionType },
      result: { status: entry.to, outcome: entry.outcome },
    });
  };
}

// ── State machine ───────────────────────────────────────────────────────────

async function applyTransition(action, to, { now, actor, reason, onAudit, patch = {}, extra = {} } = {}) {
  if (!action || typeof action !== 'object') {
    throw new TypeError('A pending action record is required');
  }
  const from = stateOf(action);
  if (!canTransition(from, to)) {
    throw new PendingActionTransitionError(from, to);
  }

  const timestamp = toISO(now) || toISO(new Date());
  const next = {
    ...action,
    state: to,
    updatedAt: timestamp,
    ...patch,
  };
  const entry = buildAuditEntry({ action, from, to, actor, reason, now: timestamp, attempt: extra.attempt, extra });
  const auditResult = await emitAudit(entry, onAudit);

  return { ok: true, action: next, audit: entry, auditResult, from, to };
}

/**
 * Create a blank pending-action record with deterministic, sanitized defaults.
 */
export function createPendingAction({ id, type, createdAt = new Date(), ...rest } = {}) {
  return {
    id: id == null ? '' : String(id),
    type: type ?? null,
    state: PENDING_ACTION_STATES.PENDING,
    attempts: 0,
    createdAt: toISO(createdAt),
    updatedAt: toISO(createdAt),
    lastAttemptAt: null,
    ...rest,
  };
}

/**
 * Attempt recovery of an action. Runs `attemptFn` once, records the attempt,
 * and transitions to `resolved` on success or to `retryable`/`failed` on
 * failure (failed once `attempts >= maxAttempts`). Never throws for a failed
 * attempt — the failure is returned as state; only an illegal transition or a
 * missing `attemptFn` throws.
 *
 * @param {object} action
 * @param {(action: object, attempt: number) => any} attemptFn
 * @param {{ now?, actor?, reason?, maxAttempts?, onAudit? }} [options]
 */
export async function retry(action, attemptFn, options = {}) {
  if (typeof attemptFn !== 'function') {
    throw new TypeError('retry(action, attemptFn) requires an attemptFn function');
  }
  const { now = new Date(), actor = 'system', reason, maxAttempts = PENDING_ACTION_MAX_ATTEMPTS, onAudit } = options;

  const from = stateOf(action);
  if (isTerminal(from)) {
    throw new PendingActionTransitionError(from, PENDING_ACTION_STATES.RETRYABLE);
  }

  const attempt = Number(action?.attempts || 0) + 1;
  const attemptAt = toISO(now) || toISO(new Date());

  let error = null;
  let succeeded = true;
  try {
    await attemptFn(action, attempt);
  } catch (caught) {
    succeeded = false;
    error = caught instanceof Error ? caught.message : String(caught ?? 'attempt failed');
  }

  if (succeeded) {
    return applyTransition(action, PENDING_ACTION_STATES.RESOLVED, {
      now,
      actor,
      reason: reason ?? 'retry_succeeded',
      onAudit,
      patch: {
        attempts: attempt,
        lastAttemptAt: attemptAt,
        resolvedAt: attemptAt,
        lastError: null,
      },
      extra: { outcome: 'resolved', attempt },
    });
  }

  const to = attempt >= maxAttempts ? PENDING_ACTION_STATES.FAILED : PENDING_ACTION_STATES.RETRYABLE;
  return applyTransition(action, to, {
    now,
    actor,
    reason: reason ?? 'retry_failed',
    onAudit,
    patch: {
      attempts: attempt,
      lastAttemptAt: attemptAt,
      lastError: error,
      failureReason: to === PENDING_ACTION_STATES.FAILED ? error : action?.failureReason ?? null,
    },
    extra: { outcome: to, attempt, error },
  });
}

/**
 * User recovery action: mark a non-terminal action as resolved without an
 * automatic retry (e.g. the user confirms the side effect landed).
 */
export async function markResolved(action, options = {}) {
  const { now = new Date(), actor = 'system', reason = 'marked_resolved', onAudit } = options;
  return applyTransition(action, PENDING_ACTION_STATES.RESOLVED, {
    now,
    actor,
    reason,
    onAudit,
    patch: { resolvedAt: toISO(now) || toISO(new Date()), lastError: null },
    extra: { outcome: 'resolved' },
  });
}

/**
 * Maintainer recovery action: resolve an action out-of-band. Requires both an
 * actor and a reason, and lands in `manually_reviewed` (not `resolved`) so the
 * distinction between automatic and human resolution stays auditable.
 */
export async function resolveManually(action, options = {}) {
  const { actor, reason, now = new Date(), onAudit } = options;
  if (!actor || !String(actor).trim()) {
    throw new TypeError('resolveManually requires an actor');
  }
  if (!reason || !String(reason).trim()) {
    throw new TypeError('resolveManually requires a reason');
  }
  const timestamp = toISO(now) || toISO(new Date());
  return applyTransition(action, PENDING_ACTION_STATES.MANUALLY_REVIEWED, {
    now,
    actor,
    reason,
    onAudit,
    patch: {
      reviewedBy: String(actor),
      reviewedAt: timestamp,
      resolutionReason: String(reason),
      lastError: null,
    },
    extra: { outcome: 'manually_reviewed' },
  });
}
