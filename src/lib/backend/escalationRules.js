/**
 * Escalation Rules Engine (#863)
 *
 * Provides configurable escalation policies for unresolved user-impacting
 * failures in EduVault. Escalation tiers are driven entirely by configuration
 * so ops teams can tune thresholds without touching source code.
 *
 * Flow:
 *  1. A failure enters the system via partialFailures.js (status = unresolved).
 *  2. A background job (or on-demand check) calls evaluateEscalation() for each
 *     unresolved failure.
 *  3. If the failure meets a tier's age + severity criteria and has not already
 *     been escalated to that tier, an EscalationEvent is recorded and a
 *     notification is emitted.
 *  4. When the failure is resolved, markEscalationResolved() stops further tiers.
 *  5. getActiveEscalationsReport() gives maintainers a live snapshot.
 */

import { SEVERITIES } from './partialFailures.js';

// ── Default escalation policy ─────────────────────────────────────────────────

/**
 * Each tier fires once when:
 *   - failure.severity matches (or severity is 'any')
 *   - failure has been unresolved for >= ageThresholdMs
 *   - the failure has not already reached this tier
 *
 * Tiers are evaluated in order; a failure that already hit tier 2 will not
 * re-fire tier 1 on the next run.
 */
export const DEFAULT_ESCALATION_POLICY = [
  {
    tier: 1,
    label: 'initial',
    ageThresholdMs: 15 * 60 * 1000,        // 15 minutes
    severities: [SEVERITIES.CRITICAL, SEVERITIES.HIGH],
    notificationChannels: ['maintainer_email'],
    description: 'First alert — high/critical failure unresolved after 15 min',
  },
  {
    tier: 2,
    label: 'elevated',
    ageThresholdMs: 60 * 60 * 1000,        // 1 hour
    severities: [SEVERITIES.CRITICAL, SEVERITIES.HIGH, SEVERITIES.MEDIUM],
    notificationChannels: ['maintainer_email', 'slack'],
    description: 'Elevated — any medium+ failure unresolved after 1 hour',
  },
  {
    tier: 3,
    label: 'critical',
    ageThresholdMs: 4 * 60 * 60 * 1000,    // 4 hours
    severities: [SEVERITIES.CRITICAL, SEVERITIES.HIGH, SEVERITIES.MEDIUM, SEVERITIES.LOW],
    notificationChannels: ['maintainer_email', 'slack', 'pagerduty'],
    description: 'Critical — any unresolved failure after 4 hours',
  },
];

// ── In-memory escalation state ────────────────────────────────────────────────
// In production this would be persisted in MongoDB (`failure_escalations` collection).
// The in-memory map keyed by failureId is sufficient for testing and single-process use.

/** @type {Map<string, EscalationState>} */
const _escalationStore = new Map();

/**
 * @typedef {object} EscalationState
 * @property {string}  failureId
 * @property {number}  highestTierReached   - 0 = not yet escalated
 * @property {boolean} resolved             - true once the failure is resolved
 * @property {EscalationEvent[]} events
 */

/**
 * @typedef {object} EscalationEvent
 * @property {number} tier
 * @property {string} label
 * @property {string[]} channels
 * @property {Date}   firedAt
 * @property {string} failureId
 * @property {string} severity
 * @property {string} operation
 */

function getOrCreateState(failureId) {
  if (!_escalationStore.has(failureId)) {
    _escalationStore.set(failureId, {
      failureId,
      highestTierReached: 0,
      resolved: false,
      events: [],
    });
  }
  return _escalationStore.get(failureId);
}

// ── Core evaluation ───────────────────────────────────────────────────────────

/**
 * Evaluate escalation tiers for a single partial failure.
 *
 * @param {object} failure  - Normalized failure from partialFailures.getPartialFailures()
 * @param {object} [opts]
 * @param {Array}  [opts.policy]   - Override the default escalation policy
 * @param {Date}   [opts.now]      - Override current time (for testing)
 * @param {Function} [opts.notify] - notify(event) hook; default is a no-op
 * @returns {EscalationEvent[]} newly fired escalation events (empty if nothing changed)
 */
export function evaluateEscalation(failure, opts = {}) {
  const {
    policy = DEFAULT_ESCALATION_POLICY,
    now = new Date(),
    notify = () => {},
  } = opts;

  const state = getOrCreateState(failure.failureId);

  if (state.resolved) return [];

  const ageMs = now - new Date(failure.createdAt);
  const newEvents = [];

  for (const tier of policy) {
    if (tier.tier <= state.highestTierReached) continue;
    if (ageMs < tier.ageThresholdMs) continue;
    if (!tier.severities.includes(failure.severity)) continue;

    const event = {
      tier: tier.tier,
      label: tier.label,
      channels: tier.notificationChannels,
      firedAt: now,
      failureId: failure.failureId,
      severity: failure.severity,
      operation: failure.operation,
      description: tier.description,
    };

    state.events.push(event);
    state.highestTierReached = tier.tier;
    newEvents.push(event);

    try {
      notify(event);
    } catch {
      // notification errors must not break the evaluation loop
    }
  }

  return newEvents;
}

/**
 * Evaluate escalation for every failure in a batch.
 *
 * @param {object[]} failures
 * @param {object}   [opts]
 * @returns {{ events: EscalationEvent[], escalatedCount: number }}
 */
export function evaluateEscalationBatch(failures, opts = {}) {
  const events = [];
  for (const failure of failures) {
    const fired = evaluateEscalation(failure, opts);
    events.push(...fired);
  }
  return { events, escalatedCount: new Set(events.map((e) => e.failureId)).size };
}

// ── Resolution ────────────────────────────────────────────────────────────────

/**
 * Mark a failure as resolved so no further escalation tiers fire for it.
 *
 * @param {string} failureId
 */
export function markEscalationResolved(failureId) {
  const state = getOrCreateState(failureId);
  state.resolved = true;
}

// ── Report ────────────────────────────────────────────────────────────────────

/**
 * Return a maintainer report of all active (unresolved) escalations, grouped
 * by tier and severity.
 *
 * @param {object} [opts]
 * @param {number} [opts.minTier=1] - Only include escalations at or above this tier
 * @returns {object} report
 */
export function getActiveEscalationsReport(opts = {}) {
  const { minTier = 1 } = opts;

  const activeStates = [..._escalationStore.values()].filter(
    (s) => !s.resolved && s.highestTierReached >= minTier
  );

  const byTier = {};
  for (const state of activeStates) {
    const tier = state.highestTierReached;
    if (!byTier[tier]) byTier[tier] = [];
    byTier[tier].push({
      failureId: state.failureId,
      highestTierReached: state.highestTierReached,
      eventCount: state.events.length,
      lastFiredAt: state.events.at(-1)?.firedAt ?? null,
      severity: state.events.at(-1)?.severity ?? null,
      operation: state.events.at(-1)?.operation ?? null,
    });
  }

  const bySeverity = {};
  for (const state of activeStates) {
    const sev = state.events.at(-1)?.severity ?? 'unknown';
    bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
  }

  return {
    total: activeStates.length,
    byTier,
    bySeverity,
    generatedAt: new Date(),
  };
}

// ── Policy helpers ────────────────────────────────────────────────────────────

/**
 * Merge a partial policy override with the default policy.
 * Callers can tighten or loosen thresholds per deployment environment.
 *
 * @param {Partial<typeof DEFAULT_ESCALATION_POLICY[number]>[]} overrides
 * @returns {typeof DEFAULT_ESCALATION_POLICY}
 */
export function buildPolicy(overrides = []) {
  return DEFAULT_ESCALATION_POLICY.map((tier) => {
    const override = overrides.find((o) => o.tier === tier.tier);
    return override ? { ...tier, ...override } : tier;
  });
}

// ── Persistence helpers (MongoDB) ─────────────────────────────────────────────

/**
 * Persist escalation events to MongoDB for durability across restarts.
 * Call this after evaluateEscalation / evaluateEscalationBatch.
 *
 * @param {import('mongodb').Db} db
 * @param {EscalationEvent[]} events
 */
export async function persistEscalationEvents(db, events) {
  if (!events.length) return;
  const col = db.collection('failure_escalations');
  await col.insertMany(
    events.map((e) => ({ ...e, createdAt: e.firedAt })),
    { ordered: false }
  );
}

/**
 * Load escalation state from MongoDB on process startup so in-memory store is
 * warmed and re-alerts are correctly deduped.
 *
 * @param {import('mongodb').Db} db
 */
export async function loadEscalationStateFromDb(db) {
  const col = db.collection('failure_escalations');
  const docs = await col.find({}).sort({ tier: 1 }).toArray();
  for (const doc of docs) {
    const state = getOrCreateState(doc.failureId);
    if (doc.tier > state.highestTierReached) {
      state.highestTierReached = doc.tier;
    }
    state.events.push(doc);
  }

  // Mark resolved failures
  const resolvedCol = db.collection('partial_failure_resolutions');
  const resolved = await resolvedCol.find({}).toArray().catch(() => []);
  for (const r of resolved) {
    if (r.failureId) markEscalationResolved(r.failureId);
  }
}

// Expose internal store for testing only — not part of the public API.
export const _testOnly = { store: _escalationStore };
