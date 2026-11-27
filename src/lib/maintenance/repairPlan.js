/**
 * Dry-run repair plans with checkpoints (#1084).
 *
 * `runResumableRepair` (resumableRepairJob.js) and `scripts/repair-materials.mjs`
 * can preview a repair, but nothing ties what an operator *reviewed* to what is
 * later *written*: an apply run re-detects against live data, overwrites whole
 * documents without checking they are unchanged, and keeps no before-image to
 * roll back from. This module splits a repair into three explicit, resumable
 * phases:
 *
 *   1. plan      Dry-run scan in `_id` order. Every proposed change is stored as
 *                a plan item holding the exact before/after values of each
 *                touched field. The scan checkpoints after every batch, so an
 *                interrupted dry-run resumes where it stopped. Nothing in the
 *                target collection is written. The finished plan gets a
 *                deterministic `planHash` over its items.
 *   2. apply     Requires an authorized operator and the `planHash` they
 *                reviewed. Each item is written with a compare-and-set filter on
 *                its before-values, so a record that changed after the dry-run
 *                is skipped as `skipped_stale` instead of being clobbered. Item
 *                status is the checkpoint: a crashed or partial apply resumes,
 *                and failed items are retried up to `maxAttempts`.
 *   3. rollback  Restores before-values for applied items, again with a
 *                compare-and-set on the after-values. A record edited since the
 *                repair is reported as `rollback_conflict`, never overwritten.
 *
 * Collections: `repair_plans` (one document per plan) and `repair_plan_items`
 * (one document per proposed record change, `_id = <planId>:<targetId>`).
 * Both are new; no existing collection or API changes shape.
 */

import crypto from "node:crypto";

import { appendAuditRecord } from "../backend/auditLedger.js";
import { hasPermission } from "../auth/permissions.js";

export const REPAIR_PERMISSION = "operations:repair";
export const REPAIR_PLANS_COLLECTION = "repair_plans";
export const REPAIR_PLAN_ITEMS_COLLECTION = "repair_plan_items";

export const REPAIR_PLAN_STATUS = Object.freeze({
  PLANNING: "planning",
  PLANNED: "planned",
  APPLYING: "applying",
  APPLIED: "applied",
  PARTIALLY_APPLIED: "partially_applied",
  ROLLED_BACK: "rolled_back",
  ROLLED_BACK_WITH_CONFLICTS: "rolled_back_with_conflicts",
});

export const REPAIR_ITEM_STATUS = Object.freeze({
  PENDING: "pending",
  APPLIED: "applied",
  SKIPPED_STALE: "skipped_stale",
  FAILED: "failed",
  ROLLED_BACK: "rolled_back",
  ROLLBACK_CONFLICT: "rollback_conflict",
});

const APPLYABLE_PLAN_STATES = new Set([
  REPAIR_PLAN_STATUS.PLANNED,
  REPAIR_PLAN_STATUS.APPLYING,
  REPAIR_PLAN_STATUS.PARTIALLY_APPLIED,
]);
const ROLLBACKABLE_PLAN_STATES = new Set([
  REPAIR_PLAN_STATUS.APPLYING,
  REPAIR_PLAN_STATUS.APPLIED,
  REPAIR_PLAN_STATUS.PARTIALLY_APPLIED,
  REPAIR_PLAN_STATUS.ROLLED_BACK_WITH_CONFLICTS,
]);

const PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_FIELDS = new Set(["_id", "__proto__", "constructor", "prototype"]);
const MAX_SAMPLES = 10;

/** Typed error so API/CLI callers can map failures to a status and a stable code. */
export class RepairPlanError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "RepairPlanError";
    this.code = code;
    this.status = status;
  }
}

function actorId(actor) {
  if (!actor) return null;
  if (typeof actor === "string") return actor;
  return actor.id ?? actor.userId ?? actor.email ?? null;
}

/**
 * An operator is authorized by an explicit `authorize(actor)` callback (same
 * contract as `runResumableRepair`) or, by default, by the role permission
 * `operations:repair` (admins hold it through `*`). Either way the actor must
 * carry an id, because every write is attributed.
 */
function assertAuthorized(actor, authorize) {
  const allowed = typeof authorize === "function" ? authorize(actor) === true : hasPermission(actor, REPAIR_PERMISSION);
  if (!allowed || !actorId(actor)) {
    throw new RepairPlanError("REPAIR_FORBIDDEN", "An authorized operator is required for this repair action", 403);
  }
}

function assertPlanId(planId) {
  if (typeof planId !== "string" || !PLAN_ID_PATTERN.test(planId)) {
    throw new RepairPlanError("REPAIR_INVALID_PLAN_ID", "planId must be 1-128 characters of [A-Za-z0-9_.:-]");
  }
}

function stableStringify(value) {
  if (value === undefined) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === "object" && typeof value.toHexString === "function") {
    return JSON.stringify(value.toHexString());
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameValue(a, b) {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Turn a detector result into a list of field changes, rejecting anything
 * that cannot be applied and rolled back field-by-field. Fields whose proposed
 * value equals the current value are dropped (a no-op is not a repair).
 */
function assertField(field) {
  if (!FIELD_PATTERN.test(field) || FORBIDDEN_FIELDS.has(field)) {
    throw new RepairPlanError(
      "REPAIR_INVALID_FIELD",
      `Repairs may only touch top-level fields matching ${FIELD_PATTERN} (got ${JSON.stringify(field)})`
    );
  }
}

/**
 * Guards are fields the detector *read* to decide on the repair (e.g. `price`
 * for "private material without a price"). They are pinned to their dry-run
 * values so a record whose inputs changed is treated as stale even when the
 * repaired field itself is untouched.
 */
function buildGuards(doc, proposal, changedFields) {
  const guard = proposal?.guard ?? [];
  if (!Array.isArray(guard)) {
    throw new RepairPlanError("REPAIR_INVALID_PROPOSAL", "guard must be an array of field names");
  }
  return [...new Set(guard)]
    .filter((field) => {
      assertField(field);
      return !changedFields.has(field);
    })
    .sort()
    .map((field) => {
      const exists = Object.prototype.hasOwnProperty.call(doc, field);
      return { field, exists, value: exists ? doc[field] : null };
    });
}

function buildChanges(doc, proposal) {
  const set = proposal?.set;
  const unset = proposal?.unset ?? [];
  if ((set !== undefined && (set === null || typeof set !== "object" || Array.isArray(set))) || !Array.isArray(unset)) {
    throw new RepairPlanError("REPAIR_INVALID_PROPOSAL", "detect() must return { set?: object, unset?: string[], guard?: string[], reason }");
  }

  const changes = [];
  const fields = [...Object.keys(set ?? {}), ...unset];
  if (new Set(fields).size !== fields.length) {
    throw new RepairPlanError("REPAIR_INVALID_PROPOSAL", "A field cannot be both set and unset in one repair");
  }
  for (const field of fields) assertField(field);

  for (const [field, after] of Object.entries(set ?? {})) {
    if (after === undefined) {
      throw new RepairPlanError("REPAIR_INVALID_PROPOSAL", `set.${field} is undefined; use unset to remove a field`);
    }
    const existed = Object.prototype.hasOwnProperty.call(doc, field);
    if (existed && sameValue(doc[field], after)) continue;
    changes.push({ field, beforeExists: existed, before: existed ? doc[field] : null, afterExists: true, after });
  }
  for (const field of unset) {
    if (!Object.prototype.hasOwnProperty.call(doc, field)) continue;
    changes.push({ field, beforeExists: true, before: doc[field], afterExists: false, after: null });
  }
  return changes.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
}

function itemId(planId, targetId) {
  return `${planId}:${stableStringify(targetId)}`;
}

function computePlanHash(items) {
  const payload = items
    .map((item) => ({ targetId: item.targetId, changes: item.changes, guards: item.guards ?? [] }))
    .sort((a, b) => {
      const ka = stableStringify(a.targetId);
      const kb = stableStringify(b.targetId);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/** Compare-and-set filter: the record must still hold `side` ("before" or "after") values. */
function casFilter(targetId, changes, side, guards = []) {
  const filter = { _id: targetId };
  for (const guard of guards) filter[guard.field] = guard.exists ? guard.value : { $exists: false };
  for (const change of changes) {
    const exists = side === "before" ? change.beforeExists : change.afterExists;
    const value = side === "before" ? change.before : change.after;
    filter[change.field] = exists ? value : { $exists: false };
  }
  return filter;
}

function casUpdate(changes, side) {
  const $set = {};
  const $unset = {};
  for (const change of changes) {
    const exists = side === "before" ? change.beforeExists : change.afterExists;
    if (exists) $set[change.field] = side === "before" ? change.before : change.after;
    else $unset[change.field] = "";
  }
  const update = {};
  if (Object.keys($set).length) update.$set = $set;
  if (Object.keys($unset).length) update.$unset = $unset;
  return update;
}

function recordHolds(doc, changes, side) {
  if (!doc) return false;
  return changes.every((change) => {
    const exists = side === "before" ? change.beforeExists : change.afterExists;
    const value = side === "before" ? change.before : change.after;
    const has = Object.prototype.hasOwnProperty.call(doc, change.field);
    return exists ? has && sameValue(doc[change.field], value) : !has;
  });
}

function errorSummary(error) {
  return { code: error?.code ?? "REPAIR_WRITE_FAILED", message: String(error?.message ?? error).slice(0, 500) };
}

async function writeAudit(db, audit, entry) {
  if (audit === false) return;
  if (typeof audit === "function") {
    await audit(entry);
    return;
  }
  await appendAuditRecord({ db, ...entry });
}

/**
 * Phase 1 — dry-run planning. Scans `collectionName` in `_id` order and stores
 * every proposed change as a plan item. Resumable: calling it again with the
 * same `planId` continues from the last checkpoint; calling it on a finished
 * plan returns the existing summary without rescanning.
 *
 * @param {object} params
 * @param {object} params.db
 * @param {string} params.planId - Stable operator-chosen id (idempotency key).
 * @param {string} params.collectionName
 * @param {object} [params.query] - Extra filter for the scan (persisted on the plan).
 * @param {(doc: object) => (null|{set?: object, unset?: string[], guard?: string[], reason?: string})} params.detect
 * @param {object|string} params.actor
 * @param {(actor: any) => boolean} [params.authorize]
 * @param {number} [params.batchSize=100]
 * @param {number} [params.maxBatches=Infinity] - Bound one invocation (cron slices, tests).
 * @param {string} [params.ruleVersion] - Recorded so an apply can be traced to detector code.
 */
export async function planRepair({
  db,
  planId,
  collectionName,
  query = {},
  detect,
  actor,
  authorize,
  batchSize = 100,
  maxBatches = Infinity,
  ruleVersion = null,
  audit,
  now = () => new Date(),
} = {}) {
  assertAuthorized(actor, authorize);
  assertPlanId(planId);
  if (!db || typeof collectionName !== "string" || !collectionName || typeof detect !== "function") {
    throw new TypeError("db, collectionName and detect are required");
  }
  if (query && Object.prototype.hasOwnProperty.call(query, "_id")) {
    throw new RepairPlanError("REPAIR_INVALID_QUERY", "query may not constrain _id; the planner owns the _id cursor");
  }

  const plans = db.collection(REPAIR_PLANS_COLLECTION);
  const items = db.collection(REPAIR_PLAN_ITEMS_COLLECTION);
  const target = db.collection(collectionName);

  let plan = await plans.findOne({ _id: planId });
  if (plan) {
    if (plan.collectionName !== collectionName || plan.queryJson !== stableStringify(query ?? {})) {
      throw new RepairPlanError(
        "REPAIR_PLAN_CONFLICT",
        `Plan ${planId} already exists for a different collection or query; choose a new planId`,
        409
      );
    }
    if (plan.status !== REPAIR_PLAN_STATUS.PLANNING) return summarizePlan(db, plan);
  } else {
    plan = {
      _id: planId,
      collectionName,
      // Stored as canonical JSON: operator queries may contain `$` operators,
      // which are not safe as stored field names.
      queryJson: stableStringify(query ?? {}),
      ruleVersion,
      status: REPAIR_PLAN_STATUS.PLANNING,
      checkpoint: { lastScannedId: null },
      scanned: 0,
      proposed: 0,
      planHash: null,
      createdBy: actorId(actor),
      createdAt: now(),
      updatedAt: now(),
    };
    await plans.insertOne(plan);
  }

  const size = Math.max(1, Math.floor(Number(batchSize)) || 1);
  const limit = Math.max(1, Number(maxBatches) || 1);
  let { lastScannedId } = plan.checkpoint ?? { lastScannedId: null };
  let { scanned, proposed } = plan;
  let batches = 0;
  let exhausted = false;

  while (batches < limit) {
    const batchQuery = { ...(query ?? {}) };
    if (lastScannedId !== null && lastScannedId !== undefined) batchQuery._id = { $gt: lastScannedId };
    const docs = await target.find(batchQuery).sort({ _id: 1 }).limit(size).toArray();
    if (docs.length === 0) {
      exhausted = true;
      break;
    }
    batches += 1;

    for (const doc of docs) {
      const proposal = await detect(doc);
      if (proposal) {
        const changes = buildChanges(doc, proposal);
        const guards = buildGuards(doc, proposal, new Set(changes.map((change) => change.field)));
        if (changes.length > 0) {
          // Deterministic item id + upsert: re-planning after a crash between
          // this write and the checkpoint below rewrites the same item.
          await items.updateOne(
            { _id: itemId(planId, doc._id) },
            {
              $set: {
                planId,
                targetId: doc._id,
                changes,
                guards,
                reason: proposal.reason ? String(proposal.reason).slice(0, 200) : null,
                status: REPAIR_ITEM_STATUS.PENDING,
                attempts: 0,
                lastError: null,
                plannedAt: now(),
              },
            },
            { upsert: true }
          );
          proposed += 1;
        }
      }
      scanned += 1;
      lastScannedId = doc._id;
    }

    await plans.updateOne(
      { _id: planId, status: REPAIR_PLAN_STATUS.PLANNING },
      { $set: { checkpoint: { lastScannedId }, scanned, proposed, updatedAt: now() } }
    );
    if (docs.length < size) {
      exhausted = true;
      break;
    }
  }

  if (!exhausted) {
    return summarizePlan(db, await plans.findOne({ _id: planId }));
  }

  const planItems = await items.find({ planId }).sort({ _id: 1 }).toArray();
  const planHash = computePlanHash(planItems);
  await plans.updateOne(
    { _id: planId, status: REPAIR_PLAN_STATUS.PLANNING },
    {
      $set: {
        status: REPAIR_PLAN_STATUS.PLANNED,
        planHash,
        proposed: planItems.length,
        plannedAt: now(),
        updatedAt: now(),
      },
    }
  );
  await writeAudit(db, audit, {
    operationId: `repair-plan:${planId}:planned`,
    action: "repair.planned",
    actor: actorId(actor),
    target: { type: "repair_plan", id: planId },
    result: "success",
    intent: { collectionName, queryJson: stableStringify(query ?? {}), ruleVersion, planHash, proposed: planItems.length, scanned },
  });
  return summarizePlan(db, await plans.findOne({ _id: planId }));
}

/**
 * Phase 2 — apply a reviewed plan. `expectedPlanHash` must equal the hash the
 * operator saw in the dry-run report, so a plan cannot be swapped between
 * review and apply. Writes are compare-and-set on the planned before-values.
 *
 * Resumable and retry-safe: pending items are applied in `_id` order, an item
 * whose record already holds the after-values (crash after write, before the
 * item update) is marked applied, and `failed` items are retried until
 * `maxAttempts`. `maxItems` bounds one invocation.
 */
export async function applyRepairPlan({
  db,
  planId,
  expectedPlanHash,
  actor,
  authorize,
  maxItems = Infinity,
  maxAttempts = 3,
  requireSeparateApprover = false,
  audit,
  now = () => new Date(),
} = {}) {
  assertAuthorized(actor, authorize);
  assertPlanId(planId);
  if (!db) throw new TypeError("db is required");

  const plans = db.collection(REPAIR_PLANS_COLLECTION);
  const items = db.collection(REPAIR_PLAN_ITEMS_COLLECTION);
  const plan = await plans.findOne({ _id: planId });
  if (!plan) throw new RepairPlanError("REPAIR_PLAN_NOT_FOUND", `Repair plan not found: ${planId}`, 404);
  if (plan.status === REPAIR_PLAN_STATUS.PLANNING) {
    throw new RepairPlanError("REPAIR_PLAN_INCOMPLETE", "The dry-run has not finished; resume planRepair first", 409);
  }
  if (!APPLYABLE_PLAN_STATES.has(plan.status)) {
    throw new RepairPlanError("REPAIR_PLAN_NOT_APPLYABLE", `Plan ${planId} is ${plan.status} and cannot be applied`, 409);
  }
  if (!expectedPlanHash || expectedPlanHash !== plan.planHash) {
    throw new RepairPlanError(
      "REPAIR_PLAN_HASH_MISMATCH",
      "expectedPlanHash does not match the planned repair; re-review the dry-run report",
      409
    );
  }
  if (requireSeparateApprover && actorId(actor) === plan.createdBy) {
    throw new RepairPlanError("REPAIR_SEPARATE_APPROVER_REQUIRED", "The plan author may not apply their own plan", 403);
  }

  // Fail closed: if the audit trail is unavailable, no record is touched.
  await writeAudit(db, audit, {
    operationId: `repair-plan:${planId}:apply-started:${actorId(actor)}`,
    action: "repair.apply_started",
    actor: actorId(actor),
    target: { type: "repair_plan", id: planId },
    result: "success",
    intent: { planHash: plan.planHash, collectionName: plan.collectionName },
  });
  await plans.updateOne(
    { _id: planId },
    { $set: { status: REPAIR_PLAN_STATUS.APPLYING, appliedBy: actorId(actor), applyStartedAt: plan.applyStartedAt ?? now(), updatedAt: now() } }
  );

  const target = db.collection(plan.collectionName);
  const attemptLimit = Math.max(1, Number(maxAttempts) || 1);
  const workLimit = Math.max(1, Number(maxItems) || 1);
  const touched = { applied: 0, alreadyApplied: 0, skippedStale: 0, failed: 0 };
  const samples = [];

  const candidates = await items
    .find({
      planId,
      $or: [{ status: REPAIR_ITEM_STATUS.PENDING }, { status: REPAIR_ITEM_STATUS.FAILED, attempts: { $lt: attemptLimit } }],
    })
    .sort({ _id: 1 })
    .limit(Number.isFinite(workLimit) ? workLimit : 0)
    .toArray();

  for (const item of candidates) {
    const attempts = (item.attempts ?? 0) + 1;
    try {
      const result = await target.updateOne(casFilter(item.targetId, item.changes, "before", item.guards), casUpdate(item.changes, "after"));
      let status = REPAIR_ITEM_STATUS.APPLIED;
      if (result && result.matchedCount > 0) {
        touched.applied += 1;
      } else {
        // Nothing matched the before-values. Either a previous run wrote the
        // record and crashed before marking the item (idempotent retry), or the
        // record changed after the dry-run (stale: never overwrite it).
        const current = await target.findOne({ _id: item.targetId });
        if (recordHolds(current, item.changes, "after")) {
          touched.alreadyApplied += 1;
        } else {
          status = REPAIR_ITEM_STATUS.SKIPPED_STALE;
          touched.skippedStale += 1;
        }
      }
      const stampField = status === REPAIR_ITEM_STATUS.APPLIED ? "appliedAt" : "skippedAt";
      await items.updateOne({ _id: item._id }, { $set: { status, attempts, lastError: null, [stampField]: now() } });
      if (samples.length < MAX_SAMPLES) samples.push({ targetId: item.targetId, status });
    } catch (error) {
      touched.failed += 1;
      await items.updateOne(
        { _id: item._id },
        { $set: { status: REPAIR_ITEM_STATUS.FAILED, attempts, lastError: errorSummary(error), failedAt: now() } }
      );
      if (samples.length < MAX_SAMPLES) samples.push({ targetId: item.targetId, status: REPAIR_ITEM_STATUS.FAILED, error: errorSummary(error).code });
    }
  }

  const counts = await countItems(items, planId);
  const retryable = await items.countDocuments({
    planId,
    $or: [{ status: REPAIR_ITEM_STATUS.PENDING }, { status: REPAIR_ITEM_STATUS.FAILED, attempts: { $lt: attemptLimit } }],
  });
  let status = REPAIR_PLAN_STATUS.APPLIED;
  if (retryable > 0) status = REPAIR_PLAN_STATUS.APPLYING;
  else if (counts[REPAIR_ITEM_STATUS.FAILED] > 0 || counts[REPAIR_ITEM_STATUS.SKIPPED_STALE] > 0) {
    status = REPAIR_PLAN_STATUS.PARTIALLY_APPLIED;
  }
  await plans.updateOne(
    { _id: planId },
    { $set: { status, updatedAt: now(), ...(status === REPAIR_PLAN_STATUS.APPLYING ? {} : { applyFinishedAt: now() }) } }
  );

  if (status !== REPAIR_PLAN_STATUS.APPLYING) {
    await writeAudit(db, audit, {
      operationId: `repair-plan:${planId}:apply-finished:${status}`,
      action: "repair.applied",
      actor: actorId(actor),
      target: { type: "repair_plan", id: planId },
      result: status === REPAIR_PLAN_STATUS.APPLIED ? "success" : "partial",
      intent: { planHash: plan.planHash, counts },
    });
  }

  return { planId, status, planHash: plan.planHash, run: touched, counts, retryable, samples };
}

/**
 * Phase 3 — roll an applied (or partially applied) plan back. Only records
 * that still hold the repaired values are restored; anything edited since the
 * repair is left alone and reported as `rollback_conflict` so an operator can
 * reconcile it by hand. Re-running a rollback is a no-op for restored items.
 */
export async function rollbackRepairPlan({ db, planId, actor, authorize, reason, audit, now = () => new Date() } = {}) {
  assertAuthorized(actor, authorize);
  assertPlanId(planId);
  if (!reason || !String(reason).trim()) {
    throw new RepairPlanError("REPAIR_ROLLBACK_REASON_REQUIRED", "A rollback reason is required");
  }

  const plans = db.collection(REPAIR_PLANS_COLLECTION);
  const items = db.collection(REPAIR_PLAN_ITEMS_COLLECTION);
  const plan = await plans.findOne({ _id: planId });
  if (!plan) throw new RepairPlanError("REPAIR_PLAN_NOT_FOUND", `Repair plan not found: ${planId}`, 404);
  if (plan.status === REPAIR_PLAN_STATUS.ROLLED_BACK) {
    return { planId, status: plan.status, counts: await countItems(items, planId), run: { restored: 0, conflicts: 0 } };
  }
  if (!ROLLBACKABLE_PLAN_STATES.has(plan.status)) {
    throw new RepairPlanError("REPAIR_PLAN_NOT_ROLLBACKABLE", `Plan ${planId} is ${plan.status}; nothing was applied`, 409);
  }

  await writeAudit(db, audit, {
    operationId: `repair-plan:${planId}:rollback-started:${actorId(actor)}`,
    action: "repair.rollback_started",
    actor: actorId(actor),
    target: { type: "repair_plan", id: planId },
    result: "success",
    reason: String(reason).slice(0, 500),
    intent: { planHash: plan.planHash },
  });

  const target = db.collection(plan.collectionName);
  const applied = await items.find({ planId, status: REPAIR_ITEM_STATUS.APPLIED }).sort({ _id: 1 }).toArray();
  const run = { restored: 0, conflicts: 0 };
  for (const item of applied) {
    const result = await target.updateOne(casFilter(item.targetId, item.changes, "after", item.guards), casUpdate(item.changes, "before"));
    let status = REPAIR_ITEM_STATUS.ROLLED_BACK;
    if (!result || result.matchedCount === 0) {
      const current = await target.findOne({ _id: item.targetId });
      if (!recordHolds(current, item.changes, "before")) status = REPAIR_ITEM_STATUS.ROLLBACK_CONFLICT;
    }
    if (status === REPAIR_ITEM_STATUS.ROLLED_BACK) run.restored += 1;
    else run.conflicts += 1;
    await items.updateOne({ _id: item._id }, { $set: { status, rolledBackAt: now() } });
  }

  const counts = await countItems(items, planId);
  const status = counts[REPAIR_ITEM_STATUS.ROLLBACK_CONFLICT] > 0 ? REPAIR_PLAN_STATUS.ROLLED_BACK_WITH_CONFLICTS : REPAIR_PLAN_STATUS.ROLLED_BACK;
  await plans.updateOne(
    { _id: planId },
    { $set: { status, rolledBackBy: actorId(actor), rollbackReason: String(reason).slice(0, 500), rolledBackAt: now(), updatedAt: now() } }
  );
  await writeAudit(db, audit, {
    operationId: `repair-plan:${planId}:rollback-finished:${status}`,
    action: "repair.rolled_back",
    actor: actorId(actor),
    target: { type: "repair_plan", id: planId },
    result: status === REPAIR_PLAN_STATUS.ROLLED_BACK ? "success" : "partial",
    intent: { counts },
  });
  return { planId, status, counts, run };
}

async function countItems(items, planId) {
  const counts = Object.fromEntries(Object.values(REPAIR_ITEM_STATUS).map((s) => [s, 0]));
  for (const status of Object.keys(counts)) {
    counts[status] = await items.countDocuments({ planId, status });
  }
  return counts;
}

/** Report for a plan: the data an operator reviews before passing `planHash` to apply. */
export async function summarizePlan(db, planOrId) {
  const plan = typeof planOrId === "string" ? await db.collection(REPAIR_PLANS_COLLECTION).findOne({ _id: planOrId }) : planOrId;
  if (!plan) throw new RepairPlanError("REPAIR_PLAN_NOT_FOUND", `Repair plan not found: ${planOrId}`, 404);
  const items = db.collection(REPAIR_PLAN_ITEMS_COLLECTION);
  const sampleItems = await items.find({ planId: plan._id }).sort({ _id: 1 }).limit(MAX_SAMPLES).toArray();
  return {
    planId: plan._id,
    status: plan.status,
    collectionName: plan.collectionName,
    ruleVersion: plan.ruleVersion ?? null,
    planHash: plan.planHash ?? null,
    scanned: plan.scanned ?? 0,
    proposed: plan.proposed ?? 0,
    checkpoint: plan.checkpoint ?? null,
    createdBy: plan.createdBy ?? null,
    counts: await countItems(items, plan._id),
    samples: sampleItems.map((item) => ({
      targetId: item.targetId,
      reason: item.reason,
      status: item.status,
      fields: item.changes.map((change) => change.field),
    })),
  };
}

export const __testing = { buildChanges, computePlanHash, casFilter, casUpdate, stableStringify };
