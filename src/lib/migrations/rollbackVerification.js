import crypto from "node:crypto";
import { AppError } from "../errors/AppError.js";
import { CheckStatus, checkDeploymentAuthorization } from "../release/releaseReadiness.js";

// Proof that a failed migration or deployment was actually undone. Running the
// rollback is not enough: it can half-apply, hit a different dataset than the
// forward step did, or leave indexes and checkpoints behind. This module takes
// a fingerprint of the affected data before the change, runs the change, and if
// it fails (or its post-checks fail) runs the rollback and then proves the data
// matches the fingerprint again. See docs/rollback-verification.md.

export const ROLLBACK_VERIFICATIONS_COLLECTION = "rollback_verifications";

export const RunState = Object.freeze({
  APPLYING: "applying",
  SUCCEEDED: "succeeded",
  ROLLING_BACK: "rolling_back",
  ROLLED_BACK_VERIFIED: "rolled_back_verified",
  ROLLBACK_DRIFT: "rollback_drift",
  ROLLBACK_FAILED: "rollback_failed",
  UNVERIFIABLE: "unverifiable",
});

// A run in one of these states blocks the next run of the same name until an
// operator fixes it and re-verifies (retryRollbackVerification).
export const UNRESOLVED_STATES = Object.freeze([
  RunState.APPLYING,
  RunState.ROLLING_BACK,
  RunState.ROLLBACK_FAILED,
  RunState.ROLLBACK_DRIFT,
  RunState.UNVERIFIABLE,
]);

export const VerificationStatus = Object.freeze({
  VERIFIED: "verified",
  DRIFT: "drift",
  UNVERIFIABLE: "unverifiable",
});

const DEFAULT_MAX_SCAN = 10_000;
const MAX_MESSAGE_LENGTH = 500;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Key-sorted JSON so equal documents hash equally whatever their field order. */
function stable(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value.toHexString === "function") return JSON.stringify(value.toHexString());
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
    .join(",")}}`;
}

function omit(doc, fields) {
  if (!fields.length) return doc;
  const copy = { ...doc };
  for (const field of fields) delete copy[field];
  return copy;
}

function normalizeTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new AppError("VALIDATION_FIELD", { message: "At least one verification target is required.", details: { field: "targets" } });
  }
  return targets.map((target) => {
    const spec = typeof target === "string" ? { collection: target } : target;
    if (!spec?.collection || typeof spec.collection !== "string") {
      throw new AppError("VALIDATION_FIELD", { message: "Each target needs a collection name.", details: { field: "targets" } });
    }
    return { collection: spec.collection, query: spec.query ?? {}, ignoreFields: spec.ignoreFields ?? [] };
  });
}

function message(error) {
  return String(error?.message ?? error).slice(0, MAX_MESSAGE_LENGTH);
}

async function withRetries(operation, { retries = 0, retryDelayMs = 50, sleep = defaultSleep } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= retries || error?.retryable === false) throw error;
      await sleep(retryDelayMs * 2 ** attempt);
    }
  }
}

/**
 * Fingerprint the data a change will touch: per target, the document count, a
 * digest of the documents (in `_id` order, first `maxScan`), and index names.
 * Scope each target with `query` to the data the change owns; live traffic that
 * writes to the same documents between capture and verify shows up as drift.
 *
 * @param {object} db
 * @param {object} options
 * @param {Array<string|{collection: string, query?: object, ignoreFields?: string[]}>} options.targets
 * @param {number} [options.maxScan] documents hashed per target
 * @param {() => Date} [options.now]
 */
export async function captureFingerprint(db, { targets, maxScan = DEFAULT_MAX_SCAN, now = () => new Date() }) {
  const specs = normalizeTargets(targets);
  const collections = {};
  for (const spec of specs) {
    const collection = db.collection(spec.collection);
    const count = await collection.countDocuments(spec.query);
    const docs = await collection.find(spec.query).sort({ _id: 1 }).limit(maxScan).toArray();
    const hash = crypto.createHash("sha256");
    for (const doc of docs) hash.update(`${stable(omit(doc, spec.ignoreFields))}\n`);
    const indexList = typeof collection.indexes === "function" ? await collection.indexes().catch(() => null) : null;
    collections[spec.collection] = {
      count,
      digest: hash.digest("hex"),
      scanned: docs.length,
      truncated: count > docs.length,
      indexes: Array.isArray(indexList) ? indexList.map((index) => index.name).sort() : null,
    };
  }
  return { capturedAt: now().toISOString(), maxScan, targets: specs, collections };
}

/**
 * Differences between two fingerprints. Content or count changes and lost
 * indexes are errors; an index the change added and the rollback left behind is
 * a warning, because it is untidy rather than unsafe.
 */
export function compareFingerprints(before, after) {
  const differences = [];
  for (const [name, expected] of Object.entries(before.collections)) {
    const actual = after.collections[name];
    if (!actual) {
      differences.push({ collection: name, type: "collection_missing", severity: "error" });
      continue;
    }
    if (actual.count !== expected.count) {
      differences.push({ collection: name, type: "count_changed", severity: "error", before: expected.count, after: actual.count });
    }
    if (actual.digest !== expected.digest) {
      differences.push({ collection: name, type: "content_changed", severity: "error", before: expected.digest, after: actual.digest, partialCoverage: expected.truncated });
    }
    if (expected.indexes && actual.indexes) {
      for (const index of expected.indexes.filter((i) => !actual.indexes.includes(i))) {
        differences.push({ collection: name, type: "index_missing", severity: "error", index });
      }
      for (const index of actual.indexes.filter((i) => !expected.indexes.includes(i))) {
        differences.push({ collection: name, type: "index_added", severity: "warning", index });
      }
    }
  }
  return {
    matches: differences.every((d) => d.severity !== "error"),
    differences,
    partialCoverage: Object.entries(before.collections).filter(([, c]) => c.truncated).map(([name]) => name),
  };
}

async function runChecks(checks, db) {
  const results = [];
  for (const check of checks) {
    try {
      const outcome = await check.run(db);
      results.push({ name: check.name, ok: Boolean(outcome?.ok), message: outcome?.message ?? null });
    } catch (error) {
      // A check that cannot run proves nothing, so it counts as failed.
      results.push({ name: check.name, ok: false, message: `check threw: ${message(error)}` });
    }
  }
  return results;
}

/**
 * Read-only comparison of the current data against a pre-change fingerprint,
 * plus any invariant checks. Safe to repeat.
 *
 * @param {object} options
 * @param {object} options.db
 * @param {object} options.before fingerprint from captureFingerprint
 * @param {Array<{name: string, run: (db: object) => Promise<{ok: boolean, message?: string}>}>} [options.invariants]
 * @param {string} [options.migrationId] also reports checkpoints the framework left open
 * @returns {Promise<{status: string, differences: object[], invariants: object[], warnings: string[], recommendation: string, verifiedAt: string}>}
 */
export async function verifyRollback({
  db, before, invariants = [], migrationId, retries = 2, retryDelayMs = 50, sleep, now = () => new Date(),
}) {
  const verifiedAt = now().toISOString();
  let after;
  try {
    after = await withRetries(() => captureFingerprint(db, { targets: before.targets, maxScan: before.maxScan, now }), { retries, retryDelayMs, sleep });
  } catch (error) {
    return {
      status: VerificationStatus.UNVERIFIABLE,
      verifiedAt,
      differences: [],
      invariants: [],
      warnings: [],
      error: message(error),
      recommendation: "The database could not be read to verify the rollback. Treat the system as unverified: restore connectivity and run retryRollbackVerification.",
    };
  }

  const comparison = compareFingerprints(before, after);
  const invariantResults = await runChecks(invariants, db);
  const warnings = comparison.differences.filter((d) => d.severity === "warning").map((d) => `${d.type}: ${d.collection}${d.index ? `.${d.index}` : ""}`);
  if (comparison.partialCoverage.length) {
    warnings.push(`partial coverage (more than ${before.maxScan} documents): ${comparison.partialCoverage.join(", ")}`);
  }

  if (migrationId) {
    try {
      const open = await db.collection("migration_checkpoints").countDocuments({ migrationId, completed: false });
      if (open > 0) warnings.push(`${open} migration checkpoint(s) for ${migrationId} left open`);
    } catch {
      warnings.push("migration checkpoints could not be read");
    }
  }

  const verified = comparison.matches && invariantResults.every((r) => r.ok);
  return {
    status: verified ? VerificationStatus.VERIFIED : VerificationStatus.DRIFT,
    verifiedAt,
    differences: comparison.differences,
    invariants: invariantResults,
    warnings,
    recommendation: verified
      ? "Data matches its pre-change state."
      : "Rollback did not restore the pre-change state. Do not resume traffic or re-run the change; repair the listed differences (or restore from backup), then run retryRollbackVerification.",
  };
}

function runs(db) {
  return db.collection(ROLLBACK_VERIFICATIONS_COLLECTION);
}

function assertAuthorized(actor) {
  const check = checkDeploymentAuthorization(actor);
  if (check.status !== CheckStatus.PASSED) {
    throw new AppError("AUTH_FORBIDDEN", { message: check.message, details: { reason: "not_authorized_for_release" } });
  }
}

function history(action, actor, at, extra = {}) {
  return { action, actor: actor?.id ?? null, at, ...extra };
}

async function record(db, runId, set, entry) {
  await runs(db).updateOne({ _id: runId }, { $set: set, $push: { history: entry } });
}

async function rollBackWithRetries(rollback, options) {
  await withRetries(() => rollback(), options);
}

async function finishVerification(db, run, { actor, invariants, retries, retryDelayMs, sleep, now }) {
  const verification = await verifyRollback({ db, before: run.before, invariants, migrationId: run.name, retries, retryDelayMs, sleep, now });
  const state = {
    [VerificationStatus.VERIFIED]: RunState.ROLLED_BACK_VERIFIED,
    [VerificationStatus.DRIFT]: RunState.ROLLBACK_DRIFT,
    [VerificationStatus.UNVERIFIABLE]: RunState.UNVERIFIABLE,
  }[verification.status];
  await record(db, run._id, { state, verification, verifiedAt: verification.verifiedAt }, history(state, actor, now(), { status: verification.status }));
  return { runId: run._id, outcome: state, verification };
}

/**
 * Run a migration or deployment step with a verified way back.
 *
 * `apply` and `rollback` are caller-supplied. `rollback` must be idempotent: it
 * is retried and may run against a half-applied change. The run is recorded in
 * `rollback_verifications`; a run left unresolved blocks the next run of the
 * same `name` so a bad state is never built on.
 *
 * @returns {Promise<{runId: string, outcome: string, error?: string, verification?: object, postChecks?: object[]}>}
 *   outcome is one of RunState: "succeeded", "rolled_back_verified", "rollback_drift",
 *   "rollback_failed" or "unverifiable". Only the first two mean the system is in a known-good state.
 */
export async function runWithRollbackVerification({
  db, name, actor, apply, rollback, targets, postChecks = [], invariants = [],
  maxScan, rollbackRetries = 2, retryDelayMs = 50, sleep, now = () => new Date(),
}) {
  assertAuthorized(actor);
  if (typeof name !== "string" || !name) {
    throw new AppError("VALIDATION_FIELD", { message: "name is required.", details: { field: "name" } });
  }
  if (typeof apply !== "function" || typeof rollback !== "function") {
    // Refusing here is the point: a change with no way back must not start.
    throw new AppError("VALIDATION_FAILED", { message: "Both apply and rollback must be provided.", details: { reason: "missing_rollback" } });
  }

  const blocking = await runs(db).findOne({ name, state: { $in: UNRESOLVED_STATES } });
  if (blocking) {
    throw new AppError("CONFLICT_STATE", {
      message: `A previous run of ${name} is unresolved (${blocking.state}).`,
      details: { reason: "unresolved_run", runId: blocking._id, state: blocking.state },
    });
  }

  const before = await captureFingerprint(db, { targets, maxScan, now });
  const run = {
    _id: crypto.randomUUID(),
    name,
    state: RunState.APPLYING,
    actor: actor.id ?? null,
    before,
    startedAt: now(),
    history: [history("started", actor, now())],
  };
  try {
    await runs(db).insertOne(run);
  } catch (error) {
    if (error?.code === 11000) {
      throw new AppError("CONFLICT_IN_PROGRESS", { message: `${name} is already running.`, details: { reason: "run_in_progress" } });
    }
    throw error;
  }

  let failure = null;
  let postCheckResults = [];
  try {
    await apply();
    postCheckResults = await runChecks(postChecks, db);
    const failed = postCheckResults.filter((r) => !r.ok);
    if (failed.length) failure = `post-checks failed: ${failed.map((r) => r.name).join(", ")}`;
  } catch (error) {
    failure = message(error);
  }

  if (!failure) {
    await record(db, run._id, { state: RunState.SUCCEEDED, completedAt: now(), postChecks: postCheckResults }, history("succeeded", actor, now()));
    return { runId: run._id, outcome: RunState.SUCCEEDED, postChecks: postCheckResults };
  }

  await record(db, run._id, { state: RunState.ROLLING_BACK, failure, postChecks: postCheckResults }, history("failed", actor, now(), { reason: failure }));
  try {
    await rollBackWithRetries(rollback, { retries: rollbackRetries, retryDelayMs, sleep });
  } catch (error) {
    const rollbackError = message(error);
    await record(db, run._id, { state: RunState.ROLLBACK_FAILED, rollbackError }, history("rollback_failed", actor, now(), { reason: rollbackError }));
    return { runId: run._id, outcome: RunState.ROLLBACK_FAILED, error: failure, rollbackError };
  }
  const result = await finishVerification(db, run, { actor, invariants, retries: rollbackRetries, retryDelayMs, sleep, now });
  return { ...result, error: failure, postChecks: postCheckResults };
}

// States where the rollback may not have completed (or even started, if the
 // runner died), so it has to be run again before there is anything to verify.
const NEEDS_ROLLBACK = [RunState.APPLYING, RunState.ROLLING_BACK, RunState.ROLLBACK_FAILED];

/**
 * Re-verify an unresolved run after an operator repaired it (or after
 * connectivity returned). For a run whose rollback failed or whose runner died
 * mid-flight, pass `rollback` to run it again first. Replaying a run that is
 * already verified just returns it.
 */
export async function retryRollbackVerification(db, {
  runId, actor, rollback, invariants = [], rollbackRetries = 2, retryDelayMs = 50, sleep, now = () => new Date(),
}) {
  assertAuthorized(actor);
  const run = await runs(db).findOne({ _id: runId });
  if (!run) throw new AppError("NOT_FOUND", { message: "Run not found." });
  if (run.state === RunState.ROLLED_BACK_VERIFIED) {
    return { runId, outcome: run.state, verification: run.verification, replayed: true };
  }
  if (run.state === RunState.SUCCEEDED) {
    throw new AppError("CONFLICT_STATE", {
      message: "Run succeeded; there is nothing to roll back.",
      details: { reason: "not_retryable", state: run.state },
    });
  }

  if (NEEDS_ROLLBACK.includes(run.state)) {
    if (typeof rollback !== "function") {
      throw new AppError("VALIDATION_FAILED", { message: `This run is ${run.state}; pass rollback to run it again.`, details: { reason: "missing_rollback" } });
    }
    try {
      await rollBackWithRetries(rollback, { retries: rollbackRetries, retryDelayMs, sleep });
    } catch (error) {
      const rollbackError = message(error);
      await record(db, runId, { rollbackError }, history("rollback_failed", actor, now(), { reason: rollbackError }));
      return { runId, outcome: RunState.ROLLBACK_FAILED, rollbackError };
    }
  }
  return finishVerification(db, run, { actor, invariants, retries: rollbackRetries, retryDelayMs, sleep, now });
}
