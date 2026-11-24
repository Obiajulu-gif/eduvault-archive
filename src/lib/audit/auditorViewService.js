import {
  exportProvenance,
  summarizeProvenance,
  traceProvenance,
  PROVENANCE_KINDS,
  provenanceToCsv,
} from "../backend/provenance.js";
import { AppError } from "../errors/AppError.js";

export const AUDITOR_ROLES = new Set(["admin", "auditor", "compliance_officer"]);
export const AUDITOR_PERMISSIONS = new Set(["audit:read", "provenance:read", "entitlements:read", "admin:manage"]);

/**
 * Validates that the actor holds auditor or administrative authority.
 */
export function validateAuditorAuthorization(user) {
  if (!user) {
    throw new AppError("AUTH_UNAUTHENTICATED", {
      message: "Authentication required to access auditor view.",
      statusCode: 401,
    });
  }

  const role = String(user.role || "").toLowerCase();
  if (AUDITOR_ROLES.has(role)) {
    return true;
  }

  const permissions = Array.isArray(user.permissions) ? user.permissions : [];
  if (permissions.some((p) => AUDITOR_PERMISSIONS.has(p))) {
    return true;
  }

  throw new AppError("AUTH_FORBIDDEN", {
    message: "Forbidden: Auditor or administrative privileges required.",
    statusCode: 403,
  });
}

/**
 * Verifies provenance integrity and ancestry closure for a set of materials.
 */
export async function verifyProvenanceIntegrity(records, resolveSource) {
  let brokenChains = 0;
  const issues = [];

  for (const record of records) {
    const prov = record.provenance;
    if (!prov) continue;

    if (prov.kind === PROVENANCE_KINDS.DERIVED) {
      const sourceId = prov.origin?.materialId;
      if (!sourceId) {
        brokenChains++;
        issues.push({ materialId: String(record._id), error: "Derived record missing parent materialId" });
        continue;
      }

      const sourceDoc = resolveSource ? await resolveSource(sourceId) : null;
      if (!sourceDoc) {
        issues.push({
          materialId: String(record._id),
          warning: `Parent material ${sourceId} not found in active catalog (may be deleted or tombstoned)`,
        });
      }
    }
  }

  return {
    verified: brokenChains === 0,
    totalRecords: records.length,
    brokenChains,
    issues,
  };
}

let MongoObjectId = null;
async function tryGetObjectId() {
  if (MongoObjectId) return MongoObjectId;
  try {
    const mongo = await import("mongodb");
    MongoObjectId = mongo.ObjectId;
    return MongoObjectId;
  } catch {
    return null;
  }
}

function parseId(id, ObjectIdClass) {
  if (!id) return id;
  if (ObjectIdClass && typeof ObjectIdClass.isValid === "function" && ObjectIdClass.isValid(id)) {
    try {
      return new ObjectIdClass(id);
    } catch {
      return id;
    }
  }
  return id;
}

/**
 * Retrieves provenance and entitlement change history for auditor review.
 */
export async function getAuditorProvenanceAndEntitlements(db, {
  materialId = null,
  buyerAddress = null,
  kind = null,
  importBatchId = null,
  actor = null,
  limit = 200,
} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 1000);
  const ObjectIdClass = await tryGetObjectId();

  const materialsColl = db.collection("materials");
  const entitlementsColl = db.collection("entitlement_cache");
  const purchasesColl = db.collection("purchases");

  // Build query for materials
  const matQuery = {};
  if (materialId) {
    matQuery._id = parseId(materialId, ObjectIdClass);
  }
  if (kind) {
    matQuery["provenance.kind"] = kind;
  }
  if (importBatchId) {
    matQuery["provenance.origin.importBatchId"] = importBatchId;
  }
  if (actor) {
    matQuery["provenance.actor.walletAddress"] = actor.toLowerCase();
  }

  // Fetch materials
  const materials = await materialsColl
    .find(matQuery, {
      projection: {
        title: 1,
        externalId: 1,
        userAddress: 1,
        visibility: 1,
        archived: 1,
        isDeleted: 1,
        price: 1,
        provenance: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    })
    .sort({ updatedAt: -1 })
    .limit(safeLimit)
    .toArray();

  // Pre-load ancestor cache for derived materials
  const ancestorCache = new Map();
  const frontier = materials
    .filter((m) => m.provenance?.kind === PROVENANCE_KINDS.DERIVED && m.provenance?.origin?.materialId)
    .map((m) => m.provenance.origin.materialId);

  if (frontier.length > 0) {
    const ids = frontier.map((id) => parseId(id, ObjectIdClass));
    const ancestors = await materialsColl
      .find({ _id: { $in: ids } })
      .toArray();
    for (const a of ancestors) {
      ancestorCache.set(String(a._id), a);
    }
  }

  const resolveSource = (id) => ancestorCache.get(String(id)) || null;

  // Format provenance rows and traces
  const traces = {};
  for (const record of materials) {
    if (record?.provenance?.kind === PROVENANCE_KINDS.DERIVED) {
      traces[String(record._id)] = traceProvenance(record.provenance, { resolveSource });
    }
  }

  const provenanceRows = exportProvenance(materials, { traces });
  const provenanceSummary = summarizeProvenance(provenanceRows);
  const integrity = await verifyProvenanceIntegrity(materials, resolveSource);

  // Fetch corresponding entitlement records
  const entQuery = {};
  if (materialId) {
    entQuery.materialId = String(materialId);
  } else if (materials.length > 0 && materials.length <= 100) {
    entQuery.materialId = { $in: materials.map((m) => String(m._id)) };
  }
  if (buyerAddress) {
    entQuery.buyerAddress = buyerAddress.toLowerCase();
  }

  const entitlements = await entitlementsColl
    .find(entQuery)
    .sort({ grantedAt: -1, updatedAt: -1 })
    .limit(safeLimit)
    .toArray();

  // Fetch purchases to enrich entitlement audit trail
  const purchaseIds = entitlements
    .map((e) => e.purchaseId)
    .filter(Boolean)
    .map((id) => parseId(id, ObjectIdClass));

  const purchaseMap = new Map();
  if (purchaseIds.length > 0) {
    const purchases = await purchasesColl.find({ _id: { $in: purchaseIds } }).toArray();
    for (const p of purchases) {
      purchaseMap.set(String(p._id), p);
    }
  }

  const entitlementAuditRows = entitlements.map((ent) => {
    const purchase = ent.purchaseId ? purchaseMap.get(String(ent.purchaseId)) : null;
    return {
      entitlementId: String(ent._id || ""),
      materialId: String(ent.materialId || ""),
      buyerAddress: ent.buyerAddress || null,
      active: ent.active !== false && !ent.revokedAt,
      status: ent.revokedAt ? "revoked" : ent.active === false ? "inactive" : "active",
      grantedAt: ent.grantedAt || ent.createdAt || null,
      revokedAt: ent.revokedAt || null,
      revokedReason: ent.revokedReason || null,
      transactionHash: ent.txHash || purchase?.txHash || null,
      ledger: ent.ledger || purchase?.ledger || null,
      purchaseId: ent.purchaseId ? String(ent.purchaseId) : null,
      pricePaid: purchase?.amount ?? null,
      asset: purchase?.asset ?? "XLM",
      hasReceiptProof: Boolean(purchase?.receiptProvenance),
    };
  });

  return {
    provenance: {
      rows: provenanceRows,
      summary: provenanceSummary,
    },
    entitlements: {
      rows: entitlementAuditRows,
      totalCount: entitlementAuditRows.length,
      activeCount: entitlementAuditRows.filter((e) => e.active).length,
      revokedCount: entitlementAuditRows.filter((e) => !e.active).length,
    },
    integrity,
    meta: {
      scannedMaterials: materials.length,
      scannedEntitlements: entitlements.length,
      filters: { materialId, buyerAddress, kind, importBatchId, actor },
      exportedAt: new Date().toISOString(),
    },
  };
}
