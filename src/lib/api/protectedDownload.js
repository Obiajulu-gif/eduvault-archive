import { ObjectId } from "mongodb";

export const ENTITLEMENT_CACHE_MAX_AGE_MS = 15 * 60 * 1000;
export const MATERIAL_DOWNLOAD_MAX_WAIT_MS = 10_000;

export class ProtectedDownloadError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "ProtectedDownloadError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isFreshTimestamp(timestamp, now = new Date()) {
  if (!timestamp) return false;
  const stamp = new Date(timestamp);
  return Number.isFinite(stamp.getTime()) && now.getTime() - stamp.getTime() <= ENTITLEMENT_CACHE_MAX_AGE_MS;
}

function normalizeMaterialLookupId(materialId) {
  return String(materialId || "").trim();
}

function materialLookupQuery(materialId) {
  const lookup = normalizeMaterialLookupId(materialId);
  if (!lookup) {
    throw new ProtectedDownloadError(400, "invalid_material_id", "Invalid material identifier");
  }

  const query = [{ materialId: lookup }, { _id: lookup }];
  if (ObjectId.isValid(lookup)) {
    query.push({ _id: new ObjectId(lookup) });
  }

  return { $or: query };
}

function buildCacheKey(material, requestedId) {
  return material.materialId || (ObjectId.isValid(requestedId) ? requestedId : material._id?.toString?.() || String(requestedId));
}

async function defaultChainVerifier({ materialId, buyerAddress, material }) {
  const endpoint = process.env.ENTITLEMENT_VERIFIER_URL;
  if (!endpoint) {
    return { status: "unavailable" };
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        materialId,
        buyerAddress,
        material: {
          id: material._id?.toString?.() || null,
          materialId: material.materialId || null,
          price: material.price ?? 0,
          visibility: material.visibility || null,
          chainContractId: material.chainContractId || null,
        },
      }),
    });

    if (!response.ok) {
      return { status: "unavailable" };
    }

    const payload = await response.json();
    if (typeof payload?.active !== "boolean") {
      return { status: "unavailable" };
    }

    return {
      status: "available",
      active: payload.active,
      source: payload.source || "chain",
      chainTxHash: payload.chainTxHash || null,
    };
  } catch {
    return { status: "unavailable" };
  }
}

async function upsertEntitlementCache(db, { materialId, buyerAddress, active, source, chainTxHash = null }) {
  await db.collection("entitlement_cache").updateOne(
    { materialId, buyerAddress },
    {
      $set: {
        materialId,
        buyerAddress,
        active,
        source,
        chainTxHash,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );
}

async function evaluateEntitlement({ db, material, requestedId, buyerAddress, verifyChainEntitlement, now }) {
  const materialId = buildCacheKey(material, requestedId);
  const cache = await db.collection("entitlement_cache").findOne({
    materialId,
    buyerAddress,
  });

  if (cache && isFreshTimestamp(cache.updatedAt, now)) {
    if (cache.active) {
      return { allowed: true, source: cache.source || "cache", materialId };
    }

    throw new ProtectedDownloadError(403, "unauthorized", "You do not have access to this material");
  }

  const verifier = verifyChainEntitlement || defaultChainVerifier;
  const verification = await verifier({
    db,
    material,
    materialId,
    buyerAddress,
    cache,
  });

  if (verification?.status !== "available") {
    throw new ProtectedDownloadError(503, "stale_entitlement", "Entitlement cache is stale");
  }

  await upsertEntitlementCache(db, {
    materialId,
    buyerAddress,
    active: Boolean(verification.active),
    source: verification.source || "chain",
    chainTxHash: verification.chainTxHash || cache?.chainTxHash || null,
  });

  if (!verification.active) {
    throw new ProtectedDownloadError(403, "unauthorized", "You do not have access to this material");
  }

  return { allowed: true, source: verification.source || "chain", materialId };
}

export async function resolveProtectedMaterialDownload({
  db,
  materialId,
  buyerAddress,
  verifyChainEntitlement,
  now = new Date(),
}) {
  if (!buyerAddress) {
    throw new ProtectedDownloadError(401, "unauthenticated", "You must sign in to download materials");
  }

  const normalizedBuyer = buyerAddress.toLowerCase();
  const material = await db.collection("materials").findOne(materialLookupQuery(materialId));

  if (!material) {
    throw new ProtectedDownloadError(404, "material_not_found", "Material not found");
  }

  const accessPrice = Number(material.price || 0);
  if (accessPrice <= 0) {
    return {
      allowed: true,
      source: "free",
      material,
      materialId: buildCacheKey(material, materialId),
    };
  }

  const entitlement = await evaluateEntitlement({
    db,
    material,
    requestedId: materialId,
    buyerAddress: normalizedBuyer,
    verifyChainEntitlement,
    now,
  });

  return {
    ...entitlement,
    material,
  };
}

export function createDownloadResponseHeaders({ material, contentType, fileName }) {
  const safeBaseName = String(fileName || material?.title || "download")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "download";

  return {
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Disposition": `attachment; filename="${safeBaseName}"`,
    "Content-Type": contentType || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  };
}

export async function fetchProtectedMaterialStream(fileUrl, { fetchImpl = fetch } = {}) {
  const trimmedUrl = String(fileUrl || "").trim();
  if (!trimmedUrl) {
    throw new ProtectedDownloadError(502, "storage_failure", "Protected file is unavailable");
  }

  const downloadUrl = trimmedUrl.startsWith("ipfs://")
    ? (() => {
        const gateway = process.env.NEXT_PUBLIC_GATEWAY_URL?.replace(/\/+$/, "");
        if (!gateway) return trimmedUrl;
        return `${gateway}/ipfs/${trimmedUrl.slice("ipfs://".length)}`;
      })()
    : trimmedUrl;

  const response = await fetchImpl(downloadUrl, { signal: AbortSignal.timeout(MATERIAL_DOWNLOAD_MAX_WAIT_MS) });
  if (!response.ok || !response.body) {
    throw new ProtectedDownloadError(502, "storage_failure", "Failed to fetch protected file");
  }

  return {
    response,
    downloadUrl,
  };
}
