#!/usr/bin/env node
/**
 * Manual repair command for known inconsistent material states — Issue #886
 *
 * Identifies repairable inconsistency classes, supports dry-run by default,
 * requires explicit --apply mode for writes, and writes audit records.
 *
 * Inconsistency classes:
 *   1. Materials with missing storageKey but present fileUrl
 *   2. Materials with visibility 'private' but price 0
 *   3. Materials with isDeleted true but stale searchVersion
 *
 * Usage:
 *   MONGODB_URI=$URI node scripts/repair-materials.mjs                    # dry-run all
 *   MONGODB_URI=$URI node scripts/repair-materials.mjs --apply            # apply all repairs
 *   MONGODB_URI=$URI node scripts/repair-materials.mjs --target <id>      # dry-run specific
 *   MONGODB_URI=$URI node scripts/repair-materials.mjs --target <id> --apply
 *
 * Checkpointed plan workflow (#1084, recommended for production — see
 * docs/repair-plans.md). Every plan command requires --operator <id> (or
 * REPAIR_OPERATOR) for attribution:
 *   ... --plan <planId>                                  # resumable dry-run; prints planHash
 *   ... --plan-status <planId>                           # report for review
 *   ... --apply-plan <planId> --plan-hash <hash>         # apply exactly the reviewed plan
 *   ... --rollback-plan <planId> --reason "<why>"        # restore before-values
 *
 * Required env vars:
 *   MONGODB_URI  — MongoDB connection string
 * Optional env vars:
 *   MONGODB_DB   — database name (default: eduvault)
 *   DRY_RUN      — set to "true" to force dry-run
 */

import { MongoClient } from "mongodb";

import {
  applyRepairPlan,
  planRepair,
  rollbackRepairPlan,
  summarizePlan,
} from "../src/lib/maintenance/repairPlan.js";
import { MATERIAL_REPAIR_RULE_VERSION, detectMaterialRepair } from "../src/lib/maintenance/materialRepairRules.js";

function log(level, message, extra = {}) {
  process.stdout.write(`${JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra })}\n`);
}

export async function findInconsistencies(db, targetId = null) {
  const materialsColl = db.collection("materials");
  const query = targetId ? { _id: targetId } : {};
  const cursor = materialsColl.find(query);
  const inconsistencies = [];

  for await (const doc of cursor) {
    const issues = [];

    if (!doc.storageKey && doc.fileUrl) {
      issues.push({
        type: "missing-storage-key",
        field: "storageKey",
        currentValue: null,
        suggestedValue: doc.fileUrl,
        description: "Material has fileUrl but missing storageKey",
      });
    }

    if (doc.visibility === "private" && (!doc.price || doc.price <= 0)) {
      issues.push({
        type: "private-without-price",
        field: "visibility",
        currentValue: "private",
        suggestedValue: "public",
        description: "Private material has no price — should be public or have a price",
      });
    }

    if (doc.isDeleted && doc.searchVersion && doc.searchVersion > 0) {
      issues.push({
        type: "deleted-with-search-version",
        field: "searchVersion",
        currentValue: doc.searchVersion,
        suggestedValue: 0,
        description: "Deleted material still has active search version",
      });
    }

    if (issues.length > 0) {
      inconsistencies.push({
        materialId: String(doc._id),
        title: doc.title,
        issues,
      });
    }
  }
  await cursor.close();

  return inconsistencies;
}

export async function repairMaterial(db, materialId, { dryRun = true } = {}) {
  const materialsColl = db.collection("materials");
  const auditColl = db.collection("repair_audit_log");

  const doc = await materialsColl.findOne({ _id: materialId });
  if (!doc) {
    return { ok: false, error: `Material not found: ${materialId}` };
  }

  const fixes = [];

  if (!doc.storageKey && doc.fileUrl) {
    fixes.push({ field: "storageKey", oldValue: null, newValue: doc.fileUrl });
  }

  if (doc.visibility === "private" && (!doc.price || doc.price <= 0)) {
    fixes.push({ field: "visibility", oldValue: "private", newValue: "public" });
  }

  if (doc.isDeleted && doc.searchVersion && doc.searchVersion > 0) {
    fixes.push({ field: "searchVersion", oldValue: doc.searchVersion, newValue: 0 });
  }

  if (fixes.length === 0) {
    return { ok: true, materialId, repaired: false, fixes: [] };
  }

  if (dryRun) {
    return { ok: true, materialId, repaired: false, dryRun: true, fixes };
  }

  const updateDoc = {};
  for (const fix of fixes) {
    updateDoc[fix.field] = fix.newValue;
  }
  updateDoc.repairedAt = new Date();
  updateDoc.repairCount = (doc.repairCount || 0) + 1;

  await materialsColl.updateOne({ _id: materialId }, { $set: updateDoc });

  const auditRecord = {
    materialId,
    action: "repair",
    fixes,
    repairedAt: new Date(),
    previousValues: fixes.reduce((acc, f) => { acc[f.field] = f.oldValue; return acc; }, {}),
  };
  const inserted = await auditColl.insertOne(auditRecord);

  return { ok: true, materialId, repaired: true, fixes, auditRecordId: inserted?.insertedId ?? auditRecord._id };
}

export async function writeAuditRecord(db, record) {
  const auditColl = db.collection("repair_audit_log");
  const doc = {
    ...record,
    timestamp: new Date(),
  };
  const result = await auditColl.insertOne(doc);
  return { ok: true, auditId: result.insertedId };
}

export async function runRepair({ mongoClient, targetId = null, dryRun = true, dbName = "eduvault" } = {}) {
  const db = mongoClient.db(dbName);

  if (targetId) {
    const result = await repairMaterial(db, targetId, { dryRun });
    return { ok: result.ok, results: [result], totalFixed: result.repaired ? 1 : 0 };
  }

  const inconsistencies = await findInconsistencies(db, targetId);
  const results = [];
  let totalFixed = 0;

  for (const item of inconsistencies) {
    const result = await repairMaterial(db, item.materialId, { dryRun });
    results.push(result);
    if (result.repaired) totalFixed++;
  }

  return {
    ok: true,
    results,
    totalFound: inconsistencies.length,
    totalFixed,
    dryRun,
  };
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index !== -1 ? argv[index + 1] ?? null : null;
}

/**
 * Runs one checkpointed plan command (#1084). Returns null when argv holds no
 * plan command, so the legacy direct-repair path keeps its behaviour.
 *
 * The CLI's authorization boundary is the database credential in MONGODB_URI;
 * an operator id is still mandatory so every plan, apply and rollback is
 * attributed in `repair_plans` and the audit ledger.
 */
export async function runPlanCommand({ db, argv, operator }) {
  const planId = argValue(argv, "--plan") ?? argValue(argv, "--plan-status") ?? argValue(argv, "--apply-plan") ?? argValue(argv, "--rollback-plan");
  if (!planId) return null;
  if (!operator) throw new Error("Plan commands require --operator <id> or REPAIR_OPERATOR");
  const common = { db, planId, actor: operator, authorize: (actor) => typeof actor === "string" && actor.trim().length > 0 };

  if (argv.includes("--plan")) {
    return planRepair({
      ...common,
      collectionName: "materials",
      detect: detectMaterialRepair,
      ruleVersion: MATERIAL_REPAIR_RULE_VERSION,
      batchSize: Number(argValue(argv, "--batch-size")) || 100,
    });
  }
  if (argv.includes("--plan-status")) return summarizePlan(db, planId);
  if (argv.includes("--apply-plan")) {
    return applyRepairPlan({ ...common, expectedPlanHash: argValue(argv, "--plan-hash") });
  }
  return rollbackRepairPlan({ ...common, reason: argValue(argv, "--reason") });
}

const isDirectCli = process.argv[1] && /repair-materials\.mjs$/.test(process.argv[1]);

if (isDirectCli) {
  (async () => {
    const mongoUri = process.env.MONGODB_URI;
    const dbName = process.env.MONGODB_DB || "eduvault";
    const dryRun = process.env.DRY_RUN === "true" || !process.argv.includes("--apply");
    const targetIdx = process.argv.indexOf("--target");
    const targetId = targetIdx !== -1 ? process.argv[targetIdx + 1] : null;

    if (!mongoUri) {
      log("error", "Missing required MONGODB_URI environment variable");
      process.exit(1);
    }

    const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10000 });
    try {
      await client.connect();

      const planResult = await runPlanCommand({
        db: client.db(dbName),
        argv: process.argv,
        operator: argValue(process.argv, "--operator") || process.env.REPAIR_OPERATOR || null,
      });
      if (planResult) {
        log("info", "Repair plan command completed", planResult);
        process.exit(0);
      }

      log("info", "Repair started", { dryRun, targetId, db: dbName });

      const result = await runRepair({ mongoClient: client, targetId, dryRun, dbName });

      if (targetId && !result.ok) {
        log("error", "Repair failed", { targetId });
        process.exit(1);
      }

      log("info", "Repair completed", {
        totalFound: result.totalFound || 0,
        totalFixed: result.totalFixed || 0,
        dryRun,
      });

      if (dryRun) {
        log("info", "DRY_RUN mode — no changes applied. Use --apply to execute repairs.");
      }

      process.exit(0);
    } catch (err) {
      log("error", "Repair failed", { error: err.message, code: err.code ?? null });
      process.exit(1);
    } finally {
      await client.close().catch(() => {});
    }
  })();
}
