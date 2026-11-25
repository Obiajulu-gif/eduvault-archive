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
