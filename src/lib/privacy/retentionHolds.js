import { createHash, randomUUID } from "node:crypto";

export const RETENTION_HOLDS_COLLECTION = "retention_holds";
export const AUDIT_LEDGER_COLLECTION = "audit_ledger";

export const HOLD_INVESTIGATION_TYPES = Object.freeze({
  REFUND: "refund_investigation",
  COMPLIANCE: "compliance_investigation",
});

export const HOLD_STATUSES = Object.freeze({
  ACTIVE: "active",
  RELEASED: "released",
  ROLLED_BACK: "rolled_back",
  EXPIRED: "expired",
});

export const MAX_TARGET_RECORDS = 500;

const COLLECTION_NAME_RE = /^[a-zA-Z0-9_]+$/;
const RESERVED_COLLECTIONS = new Set([RETENTION_HOLDS_COLLECTION, AUDIT_LEDGER_COLLECTION]);

/**
 * Defense-in-depth authorization check for retention hold operations.
 * Callers must be authenticated, non-suspended administrators.
 */
export function assertRetentionHoldAuthorized(actorContext, action = "manage") {
  if (!actorContext || typeof actorContext !== "object") {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHENTICATED",
      message: "Authentication is required to manage retention holds.",
    };
  }

  const actorId = actorContext.actorId || actorContext.walletAddress || actorContext.sub || actorContext.id;
  if (!actorId || typeof actorId !== "string") {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHENTICATED",
      message: "Authenticated actor identity is missing.",
    };
  }

  if (actorContext.suspended === true || actorContext.status === "suspended") {
    return {
      ok: false,
      status: 403,
      code: "ACTOR_SUSPENDED",
      message: "Suspended accounts cannot manage retention holds.",
    };
  }

  if (actorContext.role !== "admin") {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: `Admin role is required to ${action} retention holds.`,
    };
  }

  return { ok: true, actorId };
}

/**
 * Computes a deterministic fingerprint for idempotency conflict detection.
 */
export function computeHoldFingerprint({ investigationType, targetCollection, targetRecordIds, caseId }) {
  const canonical = JSON.stringify({
    caseId,
    investigationType,
    targetCollection,
    targetRecordIds: [...targetRecordIds].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Validates and normalizes input for creating a retention hold.
 */
export function validateCreateRetentionHoldInput(input, now = new Date()) {
  if (!input || typeof input !== "object") {
    return { ok: false, code: "INVALID_PAYLOAD", message: "Request payload must be an object." };
  }

  const validTypes = Object.values(HOLD_INVESTIGATION_TYPES);
  const investigationType =
    typeof input.investigationType === "string" ? input.investigationType.trim() : "";
  if (!validTypes.includes(investigationType)) {
    return {
      ok: false,
      code: "INVALID_INVESTIGATION_TYPE",
      message: `investigationType must be one of: ${validTypes.join(", ")}.`,
    };
  }

  const targetCollection =
    typeof input.targetCollection === "string" ? input.targetCollection.trim() : "";
  if (!targetCollection || !COLLECTION_NAME_RE.test(targetCollection) || RESERVED_COLLECTIONS.has(targetCollection)) {
    return {
      ok: false,
      code: "INVALID_TARGET_COLLECTION",
      message: "targetCollection must be a valid non-reserved collection name.",
    };
  }

  if (!Array.isArray(input.targetRecordIds) || input.targetRecordIds.length === 0) {
    return {
      ok: false,
      code: "INVALID_TARGET_RECORDS",
      message: "targetRecordIds must be a non-empty array of record IDs.",
    };
  }

  const normalizedIds = [];
  const seen = new Set();
  for (const rawId of input.targetRecordIds) {
    if (typeof rawId !== "string" && typeof rawId !== "number") {
      return {
        ok: false,
        code: "INVALID_TARGET_RECORDS",
        message: "Each targetRecordId must be a non-empty string.",
      };
    }
    const id = String(rawId).trim();
    if (!id) {
      return {
        ok: false,
        code: "INVALID_TARGET_RECORDS",
        message: "Each targetRecordId must be a non-empty string.",
      };
    }
    if (!seen.has(id)) {
      seen.add(id);
      normalizedIds.push(id);
    }
  }

  if (normalizedIds.length > MAX_TARGET_RECORDS) {
    return {
      ok: false,
      code: "TOO_MANY_TARGET_RECORDS",
      message: `targetRecordIds cannot exceed ${MAX_TARGET_RECORDS} records per hold.`,
    };
  }

  const caseId = typeof input.caseId === "string" ? input.caseId.trim() : "";
  if (!caseId || caseId.length > 128) {
    return {
      ok: false,
      code: "INVALID_CASE_ID",
      message: "caseId is required and must be 128 characters or fewer.",
    };
  }

  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason || reason.length > 1000) {
    return {
      ok: false,
      code: "INVALID_REASON",
      message: "reason is required and must be 1000 characters or fewer.",
    };
  }

  let expiresAt = null;
  if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== "") {
    const parsed = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= now.getTime()) {
      return {
        ok: false,
        code: "INVALID_EXPIRES_AT",
        message: "expiresAt must be a valid future timestamp.",
      };
    }
    expiresAt = parsed;
  }

  let idempotencyKey = null;
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null && input.idempotencyKey !== "") {
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0 || input.idempotencyKey.trim().length > 256) {
      return {
        ok: false,
        code: "INVALID_IDEMPOTENCY_KEY",
        message: "idempotencyKey must be a non-empty string of 256 characters or fewer.",
      };
    }
    idempotencyKey = input.idempotencyKey.trim();
  }

  const requireAllTargetsExist = Boolean(input.requireAllTargetsExist);

  return {
    ok: true,
    value: {
      investigationType,
      targetCollection,
      targetRecordIds: normalizedIds,
      caseId,
      reason,
      expiresAt,
      idempotencyKey,
      requireAllTargetsExist,
    },
  };
}

/**
 * Returns the record-level marker fields corresponding to an investigation type.
 * These markers align directly with `RECORD_HOLD_MARKERS` in
 * `scripts/data-retention-cleanup.mjs` to preserve existing cleanup contracts.
 */
export function getMarkersForInvestigationType(investigationType) {
  if (investigationType === HOLD_INVESTIGATION_TYPES.REFUND) {
    return { hold: true, refundPending: true };
  }
  return { hold: true, legalHold: true, auditHold: true };
}

/**
 * Returns a MongoDB filter fragment that excludes records protected by any
 * active retention hold marker.
 */
export function buildHoldExclusionFilter() {
  return {
    hold: { $ne: true },
    legalHold: { $ne: true },
    auditHold: { $ne: true },
    refundPending: { $ne: true },
    activeDispute: { $ne: true },
    settlementPending: { $ne: true },
  };
}

async function recomputeRecordMarkers({ db, targetCollection, recordId, removedHoldId, now }) {
  const holdsColl = db.collection(RETENTION_HOLDS_COLLECTION);
  const targetColl = db.collection(targetCollection);

  const remainingActiveHolds = await holdsColl
    .find({
      targetCollection,
      appliedRecordIds: recordId,
      status: HOLD_STATUSES.ACTIVE,
    })
    .toArray();

  const effectiveHolds = remainingActiveHolds.filter(
    (h) => h.holdId !== removedHoldId && (!h.expiresAt || new Date(h.expiresAt).getTime() > now.getTime())
  );

  const hasRefundHold = effectiveHolds.some(
    (h) => h.investigationType === HOLD_INVESTIGATION_TYPES.REFUND
  );
  const hasComplianceHold = effectiveHolds.some(
    (h) => h.investigationType === HOLD_INVESTIGATION_TYPES.COMPLIANCE
  );
  const stillHeld = effectiveHolds.length > 0;

  await targetColl.updateOne(
    { _id: recordId },
    {
      $pull: { retentionHoldIds: removedHoldId },
      $set: {
        hold: stillHeld,
        refundPending: hasRefundHold,
        legalHold: hasComplianceHold,
        auditHold: hasComplianceHold,
      },
    }
  );
}

async function rollbackAppliedMarkers({ db, targetCollection, appliedRecordIds, holdId, now }) {
  const rollbackErrors = [];
  for (const recordId of appliedRecordIds) {
    try {
      await recomputeRecordMarkers({
        db,
        targetCollection,
        recordId,
        removedHoldId: holdId,
        now,
      });
    } catch (err) {
      rollbackErrors.push({ recordId, error: err?.message || String(err) });
    }
  }
  return rollbackErrors;
}

/**
 * Creates a retention hold for a refund or compliance investigation.
 *
 * Covers:
 * - Authorization (admin, non-suspended)
 * - Validation
 * - Idempotent retries via `idempotencyKey` (same payload returns existing hold;
 *   mismatched payload returns 409 IDEMPOTENCY_CONFLICT)
 * - Automatic rollback of partially stamped target records if a write fails
 *   or if `requireAllTargetsExist` is violated
 * - Immutable audit logging to `audit_ledger`
 */
export async function createRetentionHold({ db, actorContext, input, now = new Date() }) {
  const auth = assertRetentionHoldAuthorized(actorContext, "create");
  if (!auth.ok) {
    return auth;
  }

  const validation = validateCreateRetentionHoldInput(input, now);
  if (!validation.ok) {
    return { ok: false, status: 400, code: validation.code, message: validation.message };
  }

  const {
    investigationType,
    targetCollection,
    targetRecordIds,
    caseId,
    reason,
    expiresAt,
    idempotencyKey,
    requireAllTargetsExist,
  } = validation.value;

  const fingerprint = computeHoldFingerprint({
    investigationType,
    targetCollection,
    targetRecordIds,
    caseId,
  });

  const holdsColl = db.collection(RETENTION_HOLDS_COLLECTION);
  const targetColl = db.collection(targetCollection);
  const auditColl = db.collection(AUDIT_LEDGER_COLLECTION);

  // Idempotency / retry check
  if (idempotencyKey) {
    const existing = await holdsColl.findOne({ idempotencyKey });
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return {
          ok: false,
          status: 409,
          code: "IDEMPOTENCY_CONFLICT",
          message: "idempotencyKey was already used with a different retention hold payload.",
        };
      }
      return {
        ok: true,
        status: 200,
        idempotent: true,
        hold: existing,
      };
    }
  }

  const holdId = `hold_${randomUUID()}`;
  const holdDoc = {
    holdId,
    status: HOLD_STATUSES.ACTIVE,
    investigationType,
    targetCollection,
    targetRecordIds,
    appliedRecordIds: [],
    missingRecordIds: [],
    caseId,
    reason,
    expiresAt,
    idempotencyKey,
    fingerprint,
    createdBy: auth.actorId,
    createdAt: now,
    updatedAt: now,
    releasedAt: null,
    releasedBy: null,
    releaseReason: null,
  };

  await holdsColl.insertOne(holdDoc);

  const markers = getMarkersForInvestigationType(investigationType);
  const appliedRecordIds = [];
  const missingRecordIds = [];

  try {
    for (const recordId of targetRecordIds) {
      const updateResult = await targetColl.updateOne(
        { _id: recordId },
        {
          $set: {
            ...markers,
            retentionHoldUpdatedAt: now,
          },
          $addToSet: {
            retentionHoldIds: holdId,
          },
        }
      );

      if (updateResult?.matchedCount > 0) {
        appliedRecordIds.push(recordId);
      } else {
        missingRecordIds.push(recordId);
      }
    }

    if (requireAllTargetsExist && missingRecordIds.length > 0) {
      const rollbackErrors = await rollbackAppliedMarkers({
        db,
        targetCollection,
        appliedRecordIds,
        holdId,
        now,
      });

      await holdsColl.updateOne(
        { holdId },
        {
          $set: {
            status: HOLD_STATUSES.ROLLED_BACK,
            missingRecordIds,
            rollbackReason: "TARGET_RECORDS_NOT_FOUND",
            rollbackErrors,
            updatedAt: now,
          },
        }
      );

      await auditColl.insertOne({
        action: "RETENTION_HOLD_ROLLED_BACK",
        holdId,
        caseId,
        investigationType,
        targetCollection,
        missingRecordIds,
        actor: auth.actorId,
        timestamp: now,
      });

      return {
        ok: false,
        status: 404,
        code: "TARGET_RECORDS_NOT_FOUND",
        message: "One or more target records were not found; hold was rolled back.",
        missingRecordIds,
        rolledBack: true,
      };
    }

    holdDoc.appliedRecordIds = appliedRecordIds;
    holdDoc.missingRecordIds = missingRecordIds;
    holdDoc.updatedAt = now;

    await holdsColl.updateOne(
      { holdId },
      {
        $set: {
          appliedRecordIds,
          missingRecordIds,
          updatedAt: now,
        },
      }
    );

    await auditColl.insertOne({
      action: "RETENTION_HOLD_CREATED",
      holdId,
      caseId,
      investigationType,
      targetCollection,
      appliedCount: appliedRecordIds.length,
      missingCount: missingRecordIds.length,
      actor: auth.actorId,
      timestamp: now,
    });

    return {
      ok: true,
      status: 201,
      idempotent: false,
      hold: holdDoc,
    };
  } catch (error) {
    const rollbackErrors = await rollbackAppliedMarkers({
      db,
      targetCollection,
      appliedRecordIds,
      holdId,
      now,
    });

    await holdsColl.updateOne(
      { holdId },
      {
        $set: {
          status: HOLD_STATUSES.ROLLED_BACK,
          rollbackReason: error?.message || "HOLD_APPLICATION_FAILED",
          rollbackErrors,
          updatedAt: now,
        },
      }
    );

    await auditColl.insertOne({
      action: "RETENTION_HOLD_FAILED",
      holdId,
      caseId,
      investigationType,
      targetCollection,
      error: error?.message || String(error),
      rollbackErrors,
      actor: auth.actorId,
      timestamp: now,
    });

    return {
      ok: false,
      status: 500,
      code: "HOLD_APPLICATION_FAILED",
      message: "Failed to apply retention hold to target records; partial changes were rolled back.",
      rolledBack: rollbackErrors.length === 0,
      rollbackErrors,
    };
  }
}

/**
 * Releases (or rolls back) an active retention hold.
 * Preserves hold markers on any target record still covered by another active hold.
 */
export async function releaseRetentionHold({
  db,
  actorContext,
  holdId,
  releaseReason,
  now = new Date(),
}) {
  const auth = assertRetentionHoldAuthorized(actorContext, "release");
  if (!auth.ok) {
    return auth;
  }

  const normalizedHoldId = typeof holdId === "string" ? holdId.trim() : "";
  const normalizedReason = typeof releaseReason === "string" ? releaseReason.trim() : "";
  if (!normalizedHoldId) {
    return { ok: false, status: 400, code: "INVALID_HOLD_ID", message: "holdId is required." };
  }
  if (!normalizedReason || normalizedReason.length > 1000) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_RELEASE_REASON",
      message: "releaseReason is required and must be 1000 characters or fewer.",
    };
  }

  const holdsColl = db.collection(RETENTION_HOLDS_COLLECTION);
  const auditColl = db.collection(AUDIT_LEDGER_COLLECTION);

  const hold = await holdsColl.findOne({ holdId: normalizedHoldId });
  if (!hold) {
    return { ok: false, status: 404, code: "HOLD_NOT_FOUND", message: "Retention hold not found." };
  }

  if (hold.status === HOLD_STATUSES.RELEASED) {
    return { ok: true, status: 200, idempotent: true, hold };
  }

  if (hold.status === HOLD_STATUSES.ROLLED_BACK) {
    return {
      ok: false,
      status: 409,
      code: "HOLD_ALREADY_ROLLED_BACK",
      message: "Cannot release a retention hold that was already rolled back.",
    };
  }

  await holdsColl.updateOne(
    { holdId: normalizedHoldId },
    {
      $set: {
        status: HOLD_STATUSES.RELEASED,
        releasedAt: now,
        releasedBy: auth.actorId,
        releaseReason: normalizedReason,
        updatedAt: now,
      },
    }
  );

  for (const recordId of hold.appliedRecordIds || []) {
    await recomputeRecordMarkers({
      db,
      targetCollection: hold.targetCollection,
      recordId,
      removedHoldId: normalizedHoldId,
      now,
    });
  }

  await auditColl.insertOne({
    action: "RETENTION_HOLD_RELEASED",
    holdId: normalizedHoldId,
    caseId: hold.caseId,
    investigationType: hold.investigationType,
    targetCollection: hold.targetCollection,
    releaseReason: normalizedReason,
    actor: auth.actorId,
    timestamp: now,
  });

  const updatedHold = {
    ...hold,
    status: HOLD_STATUSES.RELEASED,
    releasedAt: now,
    releasedBy: auth.actorId,
    releaseReason: normalizedReason,
    updatedAt: now,
  };

  return { ok: true, status: 200, idempotent: false, hold: updatedHold };
}

/**
 * Lists retention holds with optional filtering.
 */
export async function listRetentionHolds({ db, actorContext, filters = {} }) {
  const auth = assertRetentionHoldAuthorized(actorContext, "list");
  if (!auth.ok) {
    return auth;
  }

  const query = {};
  if (filters.status) query.status = String(filters.status).trim();
  if (filters.investigationType) query.investigationType = String(filters.investigationType).trim();
  if (filters.caseId) query.caseId = String(filters.caseId).trim();
  if (filters.targetCollection) query.targetCollection = String(filters.targetCollection).trim();

  const holds = await db
    .collection(RETENTION_HOLDS_COLLECTION)
    .find(query)
    .toArray();

  return { ok: true, status: 200, holds };
}
