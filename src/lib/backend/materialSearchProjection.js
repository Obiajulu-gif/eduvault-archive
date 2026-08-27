export const MATERIAL_SEARCH_COLLECTION = "material_search_documents";
export const MATERIAL_SEARCH_TOMBSTONE_COLLECTION = "material_search_tombstones";
export const MATERIAL_SEARCH_RECONCILIATION_COLLECTION = "material_search_reconciliation_audit";

const RESTRICTED_MODERATION_STATUSES = new Set(["suspended", "removed", "rejected"]);

function normalizeId(value) {
  return String(value?._id ?? value?.materialId ?? value ?? "");
}

function normalizeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateToMillis(value) {
  return normalizeDate(value)?.getTime() || 0;
}

function text(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function getMaterialSearchVersion(material) {
  const explicit = Number(material?.searchVersion ?? material?.version);
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit;
  return Math.max(
    1,
    dateToMillis(material?.updatedAt),
    dateToMillis(material?.deletedAt),
    dateToMillis(material?.archivedAt),
    dateToMillis(material?.legalRemovedAt),
  );
}

export function evaluateMaterialSearchAccess(material) {
  if (!material) return { searchable: false, reason: "missing_material", permanent: false };
  if (material.legalTombstone === true || material.legalRemovedAt || material.legalRemovalId) {
    return { searchable: false, reason: "legal_tombstone", permanent: true };
  }
  if (material.isDeleted === true) return { searchable: false, reason: "soft_deleted", permanent: false };
  if (material.archived === true) return { searchable: false, reason: "archived", permanent: false };
  if (material.visibility !== "public") return { searchable: false, reason: "not_public", permanent: false };
  if (material.creatorSuspended === true) return { searchable: false, reason: "creator_suspended", permanent: false };
  if (RESTRICTED_MODERATION_STATUSES.has(material.moderationStatus)) {
    return { searchable: false, reason: `moderation_${material.moderationStatus}`, permanent: false };
  }
  return { searchable: true, reason: "public", permanent: false };
}

export function buildMaterialSearchDocument(material, { now = new Date() } = {}) {
  const materialId = normalizeId(material);
  const access = evaluateMaterialSearchAccess(material);
  if (!access.searchable) return null;

  return {
    _id: materialId,
    materialId,
    projectionVersion: getMaterialSearchVersion(material),
    title: text(material.title, 300),
    description: text(material.description, 2000),
    shortSummary: text(material.shortSummary, 500),
    author: text(material.author || material.creatorName || material.userAddress, 300),
    category: text(material.category, 120),
    subject: text(material.subject, 120),
    level: text(material.level, 80),
    language: text(material.language, 80),
    usageRights: text(material.usageRights, 160),
    visibility: "public",
    archived: false,
    isDeleted: false,
    creatorSuspended: false,
    moderationStatus: material.moderationStatus || null,
    price: material.price ?? 0,
    rating: Number(material.rating ?? material.averageScore ?? 0) || 0,
    averageScore: Number(material.averageScore ?? material.rating ?? 0) || 0,
    feedbackCount: Number(material.feedbackCount ?? material.reviewsCount ?? 0) || 0,
    reviewsCount: Number(material.reviewsCount ?? material.feedbackCount ?? 0) || 0,
    likes: Number(material.likes ?? 0) || 0,
    thumbnailUrl: material.thumbnailUrl || null,
    fileType: material.fileType || material.contentType || material.mimeType || null,
    createdAt: normalizeDate(material.createdAt) || now,
    materialUpdatedAt: normalizeDate(material.updatedAt) || now,
    projectedAt: now,
  };
}

export function buildMaterialSearchIntent(material, { reason = "material_changed", now = new Date() } = {}) {
  const materialId = normalizeId(material);
  const access = evaluateMaterialSearchAccess(material);
  const version = getMaterialSearchVersion(material);
  return {
    type: "indexer",
    action: "material_search_sync",
    payload: {
      materialId,
      version,
      reason,
      searchable: access.searchable,
      restrictedReason: access.reason,
      permanent: access.permanent,
      material: access.searchable ? buildMaterialSearchDocument(material, { now }) : null,
      emittedAt: now.toISOString(),
    },
  };
}

export async function enqueueMaterialSearchProjection({
  db,
  material,
  reason,
  session,
  enqueue,
  now = new Date(),
}) {
  const materialId = normalizeId(material);
  const version = getMaterialSearchVersion(material);
  const enqueueSideEffect = enqueue || (await import("./outbox.js")).enqueueSideEffect;
  return enqueueSideEffect({
    db,
    session,
    sourceAggregate: "material",
    sourceId: materialId,
    deliveryId: `material-search:${materialId}:${version}:${reason || "material_changed"}`,
    intent: buildMaterialSearchIntent(material, { reason, now }),
  });
}

async function latestTombstone(db, materialId) {
  return db.collection(MATERIAL_SEARCH_TOMBSTONE_COLLECTION).findOne({ _id: materialId });
}

export async function applyMaterialSearchProjection(db, payload, { now = new Date() } = {}) {
  const materialId = String(payload?.materialId || payload?.material?._id || "");
  if (!materialId) throw new Error("material_search_sync missing materialId");

  const version = Number(payload.version ?? payload.material?.projectionVersion);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("material_search_sync missing monotonic version");
  }

  const tombstone = await latestTombstone(db, materialId);
  if (tombstone?.permanent === true || Number(tombstone?.version || 0) >= version) {
    return { action: "ignored", reason: "tombstone_newer_or_equal", materialId, version };
  }

  if (payload.searchable === false) {
    await db.collection(MATERIAL_SEARCH_COLLECTION).deleteOne({
      _id: materialId,
      projectionVersion: { $lte: version },
    });
    await db.collection(MATERIAL_SEARCH_TOMBSTONE_COLLECTION).updateOne(
      { _id: materialId },
      {
        $set: {
          materialId,
          version,
          reason: payload.restrictedReason || "restricted",
          permanent: payload.permanent === true,
          tombstonedAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
    return { action: "deleted", materialId, version };
  }

  if (!payload.material) throw new Error("searchable material_search_sync missing material document");

  const doc = {
    ...payload.material,
    _id: materialId,
    materialId,
    projectionVersion: version,
    projectedAt: now,
  };

  const existing = await db.collection(MATERIAL_SEARCH_COLLECTION).findOne({ _id: materialId });
  if (existing && Number(existing.projectionVersion || 0) >= version) {
    return { action: "ignored", reason: "projection_newer_or_equal", materialId, version };
  }

  const result = await db.collection(MATERIAL_SEARCH_COLLECTION).replaceOne(
    { _id: materialId },
    doc,
    { upsert: true },
  );

  return { action: result.upsertedCount ? "inserted" : "updated", reason: null, materialId, version };
}

function diffForMaterial(material, projection) {
  const access = evaluateMaterialSearchAccess(material);
  const version = getMaterialSearchVersion(material);
  if (!access.searchable) {
    return projection
      ? { type: "unauthorized", materialId: normalizeId(material), expectedVersion: version, actualVersion: projection.projectionVersion, reason: access.reason }
      : null;
  }
  if (!projection) {
    return { type: "missing", materialId: normalizeId(material), expectedVersion: version, actualVersion: null, reason: "searchable_material_not_projected" };
  }
  if (Number(projection.projectionVersion || 0) < version) {
    return { type: "stale", materialId: normalizeId(material), expectedVersion: version, actualVersion: projection.projectionVersion, reason: "projection_version_lag" };
  }
  return null;
}

export async function reconcileMaterialSearch({
  db,
  cursor = null,
  batchSize = 100,
  repair = false,
  runId = `search-reconcile-${Date.now()}`,
  now = new Date(),
} = {}) {
  const query = cursor ? { _id: { $gt: cursor } } : {};
  const materials = await db.collection("materials").find(query).sort({ _id: 1 }).limit(batchSize).toArray();
  const diffs = [];

  for (const material of materials) {
    const materialId = normalizeId(material);
    const projection = await db.collection(MATERIAL_SEARCH_COLLECTION).findOne({ _id: materialId });
    const diff = diffForMaterial(material, projection);
    if (!diff) continue;
    diffs.push(diff);
    if (repair) {
      await applyMaterialSearchProjection(db, buildMaterialSearchIntent(material, { reason: "reconciliation_repair", now }).payload, { now });
    }
  }

  const nextCursor = materials.length === batchSize ? materials[materials.length - 1]._id : null;
  const audit = {
    runId,
    cursor,
    nextCursor,
    batchSize,
    checked: materials.length,
    repaired: repair,
    diff: diffs,
    createdAt: now,
  };
  await db.collection(MATERIAL_SEARCH_RECONCILIATION_COLLECTION).insertOne(audit);

  return {
    runId,
    cursor,
    nextCursor,
    checked: materials.length,
    repaired: repair,
    diff: diffs,
  };
}
