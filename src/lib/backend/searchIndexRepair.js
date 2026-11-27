import crypto from "node:crypto";
import {
  MATERIAL_SEARCH_COLLECTION,
  MATERIAL_SEARCH_TOMBSTONE_COLLECTION,
  applyMaterialSearchProjection,
  buildMaterialSearchDocument,
  buildMaterialSearchIntent,
  diffForMaterial,
  evaluateMaterialSearchAccess,
  getMaterialSearchVersion,
} from "./materialSearchProjection.js";

export const MATERIAL_SEARCH_REPAIR_AUDIT_COLLECTION = "material_search_repair_audit";
export const MATERIAL_SEARCH_REPAIR_FAILURES_COLLECTION = "material_search_repair_failures";

export const REPAIR_ACTIONS = Object.freeze({
  REMOVE_UNAUTHORIZED: "remove_unauthorized",
  REMOVE_ORPHAN: "remove_orphan",
  INDEX_MISSING: "index_missing",
  REFRESH_STALE: "refresh_stale",
});

/**
 * Validates that the executing actor has administrative or repair authorization.
 * CLI executions provide { isCli: true } or system actor.
 */
export function validateRepairAuthorization(actor) {
  if (!actor) {
    const error = new Error("AUTH_UNAUTHENTICATED: Actor credentials are required for search-index repair");
    error.code = "AUTH_UNAUTHENTICATED";
    error.statusCode = 401;
    throw error;
  }

  if (actor.isCli === true || actor.role === "system") {
    return true;
  }

  const allowedRoles = new Set(["admin", "deployer", "maintainer", "release_engineer"]);
  if (actor.role && allowedRoles.has(actor.role)) {
    return true;
  }

  const permissions = Array.isArray(actor.permissions) ? actor.permissions : [];
  if (
    permissions.includes("system:repair") ||
    permissions.includes("admin:manage") ||
    permissions.includes("catalog:manage")
  ) {
    return true;
  }

  const error = new Error("AUTH_FORBIDDEN: Insufficient permissions to execute search-index repair");
  error.code = "AUTH_FORBIDDEN";
  error.statusCode = 403;
  throw error;
}

/**
 * Normalizes an identifier string.
 */
function normalizeId(value) {
  return String(value?._id ?? value?.materialId ?? value ?? "");
}

/**
 * Executes an asynchronous function with exponential backoff retry.
 */
async function withRetry(fn, { maxRetries = 3, initialDelayMs = 50 } = {}) {
  let attempt = 0;
  let delay = initialDelayMs;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= maxRetries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

/**
 * Scans the database to identify search index discrepancies:
 * 1. Projections that should no longer be public (archived, private, deleted, suspended, moderated)
 * 2. Stale projections (version lag or older than maxAgeMs)
 * 3. Projections without source materials (orphans)
 * 4. Active, public materials missing from the search index
 */
export async function scanSearchIndexInconsistencies(
  db,
  {
    limit = 500,
    maxAgeMs = 3600000,
    targetId = null,
  } = {}
) {
  const searchColl = db.collection(MATERIAL_SEARCH_COLLECTION);
  const materialsColl = db.collection("materials");
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - maxAgeMs);

  const inconsistencies = [];
  const scannedMaterialIds = new Set();

  if (targetId) {
    const singleQuery = { _id: targetId };
    const [projection, material] = await Promise.all([
      searchColl.findOne(singleQuery),
      materialsColl.findOne(singleQuery),
    ]);

    if (projection && !material) {
      inconsistencies.push({
        materialId: targetId,
        type: "orphan",
        action: REPAIR_ACTIONS.REMOVE_ORPHAN,
        reason: "projection_without_material",
        projection,
        material: null,
      });
    } else if (material) {
      const diff = diffForMaterial(material, projection);
      if (diff) {
        inconsistencies.push({
          materialId: targetId,
          type: diff.type,
          action:
            diff.type === "unauthorized"
              ? REPAIR_ACTIONS.REMOVE_UNAUTHORIZED
              : diff.type === "missing"
              ? REPAIR_ACTIONS.INDEX_MISSING
              : REPAIR_ACTIONS.REFRESH_STALE,
          reason: diff.reason,
          projection,
          material,
        });
      }
    }
    return inconsistencies;
  }

  // 1. Scan material_search_documents to verify that every indexed item is valid, authorized, and up to date
  const searchCursor = searchColl.find({}).limit(limit);
  const searchDocs = await searchCursor.toArray();

  for (const doc of searchDocs) {
    const materialId = normalizeId(doc);
    scannedMaterialIds.add(materialId);
    const material = await materialsColl.findOne({ _id: materialId });

    if (!material) {
      inconsistencies.push({
        materialId,
        type: "orphan",
        action: REPAIR_ACTIONS.REMOVE_ORPHAN,
        reason: "projection_without_material",
        projection: doc,
        material: null,
      });
      continue;
    }

    const access = evaluateMaterialSearchAccess(material);
    if (!access.searchable) {
      inconsistencies.push({
        materialId,
        type: "unauthorized",
        action: REPAIR_ACTIONS.REMOVE_UNAUTHORIZED,
        reason: access.reason || "restricted_material_present_in_search",
        projection: doc,
        material,
      });
      continue;
    }

    const version = getMaterialSearchVersion(material);
    const isStaleVersion = Number(doc.projectionVersion || 0) < version;
    const isStaleAge = doc.projectedAt && new Date(doc.projectedAt) < staleThreshold;

    if (isStaleVersion || isStaleAge) {
      inconsistencies.push({
        materialId,
        type: "stale",
        action: REPAIR_ACTIONS.REFRESH_STALE,
        reason: isStaleVersion ? "projection_version_lag" : "projection_max_age_exceeded",
        projection: doc,
        material,
      });
    }
  }

  // 2. Scan public materials to discover any that are missing from the search index
  const publicMaterialsCursor = materialsColl
    .find({
      visibility: "public",
      archived: { $ne: true },
      isArchived: { $ne: true },
      isDeleted: { $ne: true },
      creatorSuspended: { $ne: true },
      legalTombstone: { $ne: true },
    })
    .limit(limit);

  const publicMaterials = await publicMaterialsCursor.toArray();
  for (const mat of publicMaterials) {
    const materialId = normalizeId(mat);
    if (scannedMaterialIds.has(materialId)) continue;
    scannedMaterialIds.add(materialId);

    const projection = await searchColl.findOne({ _id: materialId });
    if (!projection) {
      inconsistencies.push({
        materialId,
        type: "missing",
        action: REPAIR_ACTIONS.INDEX_MISSING,
        reason: "searchable_material_not_projected",
        projection: null,
        material: mat,
      });
    }
  }

  return inconsistencies.slice(0, limit);
}

/**
 * Main search-index repair routine.
 * Supports dryRun (default true), retries, granular audit trails, and error quarantine.
 */
export async function repairSearchIndex(
  db,
  {
    dryRun = true,
    limit = 500,
    maxAgeMs = 3600000,
    targetId = null,
    actor = { role: "system", isCli: true },
    maxRetries = 3,
    now = new Date(),
  } = {}
) {
  validateRepairAuthorization(actor);

  const startTime = Date.now();
  const runId = `search-repair-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  const inconsistencies = await scanSearchIndexInconsistencies(db, {
    limit,
    maxAgeMs,
    targetId,
  });

  const summary = {
    runId,
    actor: {
      id: actor.id || actor.sub || actor.walletAddress || "system",
      role: actor.role || "unknown",
    },
    dryRun,
    targetId: targetId || null,
    scanned: inconsistencies.length,
    repaired: 0,
    removed: 0,
    missing: 0,
    stale: 0,
    unauthorized: 0,
    orphaned: 0,
    failures: [],
    actions: [],
    durationMs: 0,
  };

  for (const item of inconsistencies) {
    if (item.action === REPAIR_ACTIONS.REMOVE_UNAUTHORIZED) {
      summary.unauthorized++;
    } else if (item.action === REPAIR_ACTIONS.REMOVE_ORPHAN) {
      summary.orphaned++;
    } else if (item.action === REPAIR_ACTIONS.INDEX_MISSING) {
      summary.missing++;
    } else if (item.action === REPAIR_ACTIONS.REFRESH_STALE) {
      summary.stale++;
    }
  }

  if (dryRun) {
    summary.durationMs = Date.now() - startTime;
    return summary;
  }

  const searchColl = db.collection(MATERIAL_SEARCH_COLLECTION);
  const tombstoneColl = db.collection(MATERIAL_SEARCH_TOMBSTONE_COLLECTION);
  const auditColl = db.collection(MATERIAL_SEARCH_REPAIR_AUDIT_COLLECTION);
  const failureColl = db.collection(MATERIAL_SEARCH_REPAIR_FAILURES_COLLECTION);

  for (const item of inconsistencies) {
    const { materialId, action, reason, projection, material } = item;

    try {
      await withRetry(
        async () => {
          if (
            action === REPAIR_ACTIONS.REMOVE_UNAUTHORIZED ||
            action === REPAIR_ACTIONS.REMOVE_ORPHAN
          ) {
            // Delete projection from search index and record tombstone
            await searchColl.deleteOne({ _id: materialId });
            const tombstoneVersion = material
              ? getMaterialSearchVersion(material)
              : projection?.projectionVersion || 1;

            await tombstoneColl.updateOne(
              { _id: materialId },
              {
                $set: {
                  materialId,
                  version: tombstoneVersion,
                  reason: reason || "repair_removal",
                  permanent: material?.legalTombstone === true,
                  repairedAt: now,
                  updatedAt: now,
                },
              },
              { upsert: true }
            );

            summary.removed++;
            summary.repaired++;
            summary.actions.push({
              materialId,
              action,
              reason,
              previousState: projection,
              newState: null,
            });
          } else if (
            action === REPAIR_ACTIONS.INDEX_MISSING ||
            action === REPAIR_ACTIONS.REFRESH_STALE
          ) {
            // Re-project material into search index
            if (!material) {
              throw new Error(`Cannot project missing material: ${materialId}`);
            }

            const intent = buildMaterialSearchIntent(material, {
              reason: "search_index_repair",
              now,
            });
            await applyMaterialSearchProjection(db, intent.payload, { now });

            summary.repaired++;
            summary.actions.push({
              materialId,
              action,
              reason,
              previousState: projection || null,
              newState: intent.payload.material,
            });
          }
        },
        { maxRetries }
      );
    } catch (err) {
      const failureRecord = {
        runId,
        materialId,
        action,
        reason,
        errorMessage: err.message,
        timestamp: new Date(),
      };
      summary.failures.push(failureRecord);
      await failureColl.insertOne(failureRecord).catch(() => {});
    }
  }

  summary.durationMs = Date.now() - startTime;

  // Persist run audit record
  await auditColl.insertOne({
    ...summary,
    createdAt: now,
  });

  return summary;
}

/**
 * Rollback routine: restores search index state to prior to a specific repair run.
 */
export async function rollbackSearchIndexRepair(db, { runId, actor = { role: "system", isCli: true } }) {
  validateRepairAuthorization(actor);

  const auditColl = db.collection(MATERIAL_SEARCH_REPAIR_AUDIT_COLLECTION);
  const searchColl = db.collection(MATERIAL_SEARCH_COLLECTION);
  const tombstoneColl = db.collection(MATERIAL_SEARCH_TOMBSTONE_COLLECTION);

  const auditRecord = await auditColl.findOne({ runId });
  if (!auditRecord) {
    const error = new Error(`NOT_FOUND: No repair audit record found for runId ${runId}`);
    error.code = "NOT_FOUND";
    error.statusCode = 404;
    throw error;
  }

  if (auditRecord.rolledBack === true) {
    const error = new Error(`CONFLICT: Repair run ${runId} has already been rolled back`);
    error.code = "CONFLICT";
    error.statusCode = 409;
    throw error;
  }

  const actions = auditRecord.actions || [];
  let rolledBackCount = 0;

  for (const action of actions) {
    const { materialId, previousState } = action;

    if (previousState) {
      // Restore previously existing document
      await searchColl.replaceOne({ _id: materialId }, previousState, { upsert: true });
      await tombstoneColl.deleteOne({ _id: materialId });
      rolledBackCount++;
    } else {
      // Document was newly inserted by repair; revert by deleting it
      await searchColl.deleteOne({ _id: materialId });
      rolledBackCount++;
    }
  }

  await auditColl.updateOne(
    { runId },
    {
      $set: {
        rolledBack: true,
        rolledBackAt: new Date(),
        rolledBackBy: actor.id || actor.sub || "system",
        rolledBackCount,
      },
    }
  );

  return {
    ok: true,
    runId,
    rolledBackCount,
    rolledBackAt: new Date(),
  };
}
