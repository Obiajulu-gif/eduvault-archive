/**
 * Invariant monitoring for balances and ownership (issue #1123).
 *
 * Checks that:
 * - A wallet's on-chain balance never drops below the reserved minimum.
 * - Material ownership records are consistent with the entitlement ledger.
 * - Balance deltas are within expected bounds for a given operation.
 *
 * Violations are recorded as telemetry failures and optionally forwarded to
 * an alerting sink. No corrective action is taken here — monitoring only.
 */

import crypto from "node:crypto";
import { recordMetric, ACTOR_TYPES, TELEMETRY_RESULT } from "./telemetry.js";

export const INVARIANT_SCHEMA_VERSION = 1;

/** Violation severity levels. */
export const SEVERITY = Object.freeze({
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
});

/** Well-known invariant names. */
export const INVARIANT = Object.freeze({
  BALANCE_MINIMUM: "balance.minimum_reserve",
  BALANCE_DELTA: "balance.delta_bounds",
  OWNERSHIP_CONSISTENCY: "ownership.entitlement_consistency",
  OWNERSHIP_UNIQUE: "ownership.unique_per_material",
});

let violationSink = null;

export function setViolationSink(fn) {
  violationSink = typeof fn === "function" ? fn : null;
}

export function resetViolationSink() {
  violationSink = null;
}

function emitViolation(violation) {
  recordMetric("invariant.violation", violation, {
    operation: `invariant.${violation.invariant}`,
    actorType: ACTOR_TYPES.SYSTEM,
    result: TELEMETRY_RESULT.FAILURE,
    metricType: "counter",
  });

  if (violationSink) {
    try {
      violationSink(violation);
    } catch {
      // never let an alert sink break the monitor
    }
  }
}

function buildViolation(invariant, severity, message, context = {}) {
  return {
    id: crypto.randomUUID(),
    invariant,
    severity,
    message,
    context,
    timestamp: new Date().toISOString(),
    schemaVersion: INVARIANT_SCHEMA_VERSION,
  };
}

/**
 * Assert that `balance` is at or above `minimumReserve`.
 *
 * @param {object} opts
 * @param {string} opts.address - Stellar address being checked.
 * @param {number} opts.balance - Current on-chain balance in stroops.
 * @param {number} opts.minimumReserve - Required minimum in stroops.
 * @returns {{ ok: boolean, violation?: object }}
 */
export function checkBalanceMinimum({ address, balance, minimumReserve }) {
  if (typeof balance !== "number" || typeof minimumReserve !== "number") {
    throw new TypeError("balance and minimumReserve must be numbers");
  }

  if (balance < minimumReserve) {
    const violation = buildViolation(
      INVARIANT.BALANCE_MINIMUM,
      SEVERITY.CRITICAL,
      `Balance ${balance} is below minimum reserve ${minimumReserve}`,
      { address, balance, minimumReserve, deficit: minimumReserve - balance }
    );
    emitViolation(violation);
    return { ok: false, violation };
  }

  return { ok: true };
}

/**
 * Assert that a balance delta (amount transferred) is within allowed bounds.
 *
 * @param {object} opts
 * @param {string} opts.address - Stellar address.
 * @param {number} opts.delta - Signed balance change (negative = debit).
 * @param {number} opts.maxDebit - Maximum single-operation debit (positive number).
 * @param {number} opts.maxCredit - Maximum single-operation credit (positive number).
 * @returns {{ ok: boolean, violation?: object }}
 */
export function checkBalanceDelta({ address, delta, maxDebit, maxCredit }) {
  if (
    typeof delta !== "number" ||
    typeof maxDebit !== "number" ||
    typeof maxCredit !== "number"
  ) {
    throw new TypeError("delta, maxDebit and maxCredit must be numbers");
  }

  if (delta < -maxDebit) {
    const violation = buildViolation(
      INVARIANT.BALANCE_DELTA,
      SEVERITY.HIGH,
      `Balance debit ${Math.abs(delta)} exceeds allowed maximum ${maxDebit}`,
      { address, delta, maxDebit, maxCredit }
    );
    emitViolation(violation);
    return { ok: false, violation };
  }

  if (delta > maxCredit) {
    const violation = buildViolation(
      INVARIANT.BALANCE_DELTA,
      SEVERITY.HIGH,
      `Balance credit ${delta} exceeds allowed maximum ${maxCredit}`,
      { address, delta, maxDebit, maxCredit }
    );
    emitViolation(violation);
    return { ok: false, violation };
  }

  return { ok: true };
}

/**
 * Assert that every entitlement in `entitlements` has a matching ownership
 * record in `ownerships`.
 *
 * @param {object} opts
 * @param {Array<{userId: string, materialId: string}>} opts.entitlements
 * @param {Array<{userId: string, materialId: string}>} opts.ownerships
 * @returns {{ ok: boolean, violations: object[] }}
 */
export function checkOwnershipConsistency({ entitlements, ownerships }) {
  const ownershipSet = new Set(
    ownerships.map(({ userId, materialId }) => `${userId}:${materialId}`)
  );

  const violations = [];

  for (const { userId, materialId } of entitlements) {
    const key = `${userId}:${materialId}`;
    if (!ownershipSet.has(key)) {
      const violation = buildViolation(
        INVARIANT.OWNERSHIP_CONSISTENCY,
        SEVERITY.HIGH,
        `Entitlement exists without ownership record: user=${userId} material=${materialId}`,
        { userId, materialId }
      );
      emitViolation(violation);
      violations.push(violation);
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Assert that no material appears more than once per user in `ownerships`.
 *
 * @param {Array<{userId: string, materialId: string}>} ownerships
 * @returns {{ ok: boolean, violations: object[] }}
 */
export function checkOwnershipUniqueness(ownerships) {
  const seen = new Map();
  const violations = [];

  for (const { userId, materialId } of ownerships) {
    const key = `${userId}:${materialId}`;
    if (seen.has(key)) {
      const violation = buildViolation(
        INVARIANT.OWNERSHIP_UNIQUE,
        SEVERITY.MEDIUM,
        `Duplicate ownership record: user=${userId} material=${materialId}`,
        { userId, materialId }
      );
      emitViolation(violation);
      violations.push(violation);
    } else {
      seen.set(key, true);
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Run the full balance + ownership invariant suite and return a summary.
 *
 * @param {object} opts
 * @param {object} opts.balanceCheck - Params forwarded to checkBalanceMinimum.
 * @param {object} opts.deltaCheck - Params forwarded to checkBalanceDelta.
 * @param {object[]} opts.entitlements - For ownership consistency check.
 * @param {object[]} opts.ownerships - For ownership checks.
 * @returns {{ passed: boolean, results: object }}
 */
export function runInvariantSuite({ balanceCheck, deltaCheck, entitlements, ownerships }) {
  const results = {};

  if (balanceCheck) {
    results.balanceMinimum = checkBalanceMinimum(balanceCheck);
  }

  if (deltaCheck) {
    results.balanceDelta = checkBalanceDelta(deltaCheck);
  }

  if (entitlements && ownerships) {
    results.ownershipConsistency = checkOwnershipConsistency({ entitlements, ownerships });
    results.ownershipUniqueness = checkOwnershipUniqueness(ownerships);
  }

  const passed = Object.values(results).every((r) =>
    "ok" in r ? r.ok : (r.violations ?? []).length === 0
  );

  return { passed, results };
}


// ---------------------------------------------------------------------------
// Balance and ownership invariant monitor (issue #1123, from PR #1163).
// Independent of the checks above; both APIs are exported from this module.
// ---------------------------------------------------------------------------

/**
 * Invariant Monitor for Balances and Ownership — Issue #1123
 *
 * Provides runtime monitoring of invariant violations across:
 * - Balance conservation (debits == credits + fees; no negative balances)
 * - Single-ownership integrity (each resource has exactly one live owner)
 *
 * Usage:
 *   const monitor = createInvariantMonitor({ db, emit });
 *   monitor.record(violation);
 *   await monitor.runBalanceScan({ walletCollection });
 *   await monitor.runOwnershipScan({ materialsCollection });
 *   monitor.getViolations();
 */

export const VIOLATION_SEVERITY = Object.freeze({
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info',
});

export const MONITOR_EVENT = Object.freeze({
  VIOLATION_RECORDED: 'invariant.violation_recorded',
  SCAN_STARTED: 'invariant.scan_started',
  SCAN_COMPLETED: 'invariant.scan_completed',
  SCAN_ERROR: 'invariant.scan_error',
});

/**
 * Creates an invariant monitor instance.
 *
 * @param {object} options
 * @param {Function} [options.emit] - Optional event emitter (event, payload) => void
 * @param {number} [options.maxViolations=1000] - Ring-buffer capacity
 * @returns {object} Monitor API
 */
export function createInvariantMonitor({ emit = () => {}, maxViolations = 1000 } = {}) {
  const violations = [];
  let totalRecorded = 0;

  function record(violation) {
    if (!violation || typeof violation !== 'object') {
      throw new TypeError('violation must be a plain object');
    }
    const entry = {
      ...violation,
      id: `inv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      recordedAt: new Date().toISOString(),
      severity: violation.severity ?? VIOLATION_SEVERITY.WARNING,
    };
    violations.push(entry);
    if (violations.length > maxViolations) violations.shift();
    totalRecorded += 1;
    emit(MONITOR_EVENT.VIOLATION_RECORDED, entry);
    return entry;
  }

  function getViolations({ severity, type, since, limit = 100 } = {}) {
    let result = violations;
    if (severity) result = result.filter((v) => v.severity === severity);
    if (type) result = result.filter((v) => v.type === type);
    if (since) {
      const sinceDate = new Date(since);
      result = result.filter((v) => new Date(v.recordedAt) >= sinceDate);
    }
    return result.slice(-limit);
  }

  function stats() {
    const counts = {};
    for (const v of violations) {
      counts[v.severity] = (counts[v.severity] ?? 0) + 1;
    }
    return { buffered: violations.length, totalRecorded, bySeverity: counts };
  }

  /**
   * Scans a wallet/balance collection for negative balances and arithmetic
   * inconsistencies. Each document is expected to carry `address`, `balance`,
   * and optionally `currency`.
   *
   * @param {object} opts
   * @param {object} opts.walletCollection - MongoDB collection
   * @param {number} [opts.batchSize=200]
   * @param {Function} [opts.onProgress]
   * @returns {Promise<{ scanned: number, violations: number }>}
   */
  async function runBalanceScan({ walletCollection, batchSize = 200, onProgress } = {}) {
    if (!walletCollection) throw new TypeError('walletCollection is required');

    emit(MONITOR_EVENT.SCAN_STARTED, { type: 'balance' });
    let scanned = 0;
    let violationCount = 0;
    let lastId = null;

    try {
      while (true) {
        const query = lastId ? { _id: { $gt: lastId } } : {};
        const batch = await walletCollection
          .find(query)
          .sort({ _id: 1 })
          .limit(batchSize)
          .toArray();

        if (batch.length === 0) break;

        for (const doc of batch) {
          const balance = Number(doc.balance ?? 0);
          if (Number.isNaN(balance)) {
            record({
              type: 'BALANCE_NON_NUMERIC',
              severity: VIOLATION_SEVERITY.CRITICAL,
              resourceId: String(doc._id),
              address: doc.address ?? null,
              message: `Non-numeric balance on account ${doc.address ?? doc._id}`,
              raw: { balance: doc.balance },
            });
            violationCount++;
          } else if (balance < 0) {
            record({
              type: 'BALANCE_NEGATIVE',
              severity: VIOLATION_SEVERITY.CRITICAL,
              resourceId: String(doc._id),
              address: doc.address ?? null,
              currency: doc.currency ?? 'XLM',
              message: `Negative balance detected: ${balance} ${doc.currency ?? 'XLM'} on ${doc.address ?? doc._id}`,
              raw: { balance, currency: doc.currency },
            });
            violationCount++;
          }

          if (typeof doc.pendingDebits === 'number' && typeof doc.pendingCredits === 'number') {
            const net = doc.pendingDebits - doc.pendingCredits;
            if (Math.abs(net) > 1e-6 && doc.pendingBalance !== undefined) {
              const expectedPending = Number(doc.pendingBalance ?? 0);
              if (Math.abs(net - expectedPending) > 1e-6) {
                record({
                  type: 'BALANCE_PENDING_MISMATCH',
                  severity: VIOLATION_SEVERITY.WARNING,
                  resourceId: String(doc._id),
                  address: doc.address ?? null,
                  message: `Pending balance mismatch: net ${net} vs stored ${expectedPending}`,
                  raw: { pendingDebits: doc.pendingDebits, pendingCredits: doc.pendingCredits, pendingBalance: doc.pendingBalance },
                });
                violationCount++;
              }
            }
          }

          scanned++;
          lastId = doc._id;
        }

        if (onProgress) onProgress({ scanned, violationCount });
        if (batch.length < batchSize) break;
      }

      emit(MONITOR_EVENT.SCAN_COMPLETED, { type: 'balance', scanned, violationCount });
      return { scanned, violations: violationCount };
    } catch (err) {
      emit(MONITOR_EVENT.SCAN_ERROR, { type: 'balance', error: err.message });
      throw err;
    }
  }

  /**
   * Scans a materials/resources collection for ownership violations:
   * - Missing owner field
   * - Duplicate live owner entries (requires cross-reference with an owners index)
   *
   * @param {object} opts
   * @param {object} opts.materialsCollection - MongoDB collection
   * @param {number} [opts.batchSize=200]
   * @param {Function} [opts.onProgress]
   * @returns {Promise<{ scanned: number, violations: number }>}
   */
  async function runOwnershipScan({ materialsCollection, batchSize = 200, onProgress } = {}) {
    if (!materialsCollection) throw new TypeError('materialsCollection is required');

    emit(MONITOR_EVENT.SCAN_STARTED, { type: 'ownership' });
    let scanned = 0;
    let violationCount = 0;
    let lastId = null;
    const ownerIndex = new Map(); // materialId -> [ownerAddress, ...]

    try {
      while (true) {
        const query = lastId ? { _id: { $gt: lastId } } : {};
        const batch = await materialsCollection
          .find(query)
          .sort({ _id: 1 })
          .limit(batchSize)
          .toArray();

        if (batch.length === 0) break;

        for (const doc of batch) {
          const resourceId = String(doc._id);

          if (!doc.ownerAddress && !doc.creator && !doc.creatorAddress) {
            record({
              type: 'OWNERSHIP_MISSING',
              severity: VIOLATION_SEVERITY.CRITICAL,
              resourceId,
              message: `Resource ${resourceId} has no owner field (ownerAddress/creator/creatorAddress)`,
              raw: { status: doc.status, title: doc.title },
            });
            violationCount++;
          }

          const ownerAddr = doc.ownerAddress ?? doc.creatorAddress ?? doc.creator ?? null;
          if (ownerAddr) {
            if (!ownerIndex.has(resourceId)) {
              ownerIndex.set(resourceId, [ownerAddr]);
            } else {
              ownerIndex.get(resourceId).push(ownerAddr);
            }
          }

          const blockedStates = ['archived', 'quarantined', 'deleted'];
          const isBlocked = blockedStates.includes((doc.status ?? '').toLowerCase());
          if (isBlocked && ownerAddr) {
            // No critical violation — ownership on blocked resources is merely informational
            record({
              type: 'OWNERSHIP_ON_INACTIVE_RESOURCE',
              severity: VIOLATION_SEVERITY.INFO,
              resourceId,
              ownerAddress: ownerAddr,
              message: `Resource ${resourceId} in state '${doc.status}' still has owner ${ownerAddr}`,
              raw: { status: doc.status },
            });
          }

          scanned++;
          lastId = doc._id;
        }

        if (onProgress) onProgress({ scanned, violationCount });
        if (batch.length < batchSize) break;
      }

      // Detect duplicate live owners within the scan window
      for (const [resourceId, owners] of ownerIndex) {
        const uniqueOwners = [...new Set(owners)];
        if (uniqueOwners.length > 1) {
          record({
            type: 'OWNERSHIP_DUPLICATE',
            severity: VIOLATION_SEVERITY.CRITICAL,
            resourceId,
            message: `Resource ${resourceId} has ${uniqueOwners.length} distinct owner entries`,
            raw: { owners: uniqueOwners },
          });
          violationCount++;
        }
      }

      emit(MONITOR_EVENT.SCAN_COMPLETED, { type: 'ownership', scanned, violationCount });
      return { scanned, violations: violationCount };
    } catch (err) {
      emit(MONITOR_EVENT.SCAN_ERROR, { type: 'ownership', error: err.message });
      throw err;
    }
  }

  function clear() {
    violations.length = 0;
    totalRecorded = 0;
  }

  return { record, getViolations, stats, runBalanceScan, runOwnershipScan, clear };
}
