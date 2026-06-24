export const COMPLETED_PURCHASE_STATUSES = new Set(["confirmed", "settled", "completed"]);
export const INCOMPLETE_PURCHASE_STATUSES = new Set(["pending", "indexing", "processing", "requires_payment"]);
export const FAILED_PURCHASE_STATUSES = new Set(["failed", "cancelled", "canceled", "expired"]);

export function normalizeBuyerAddress(address) {
  return String(address || "").trim().toLowerCase();
}

export function isCompletedPurchaseStatus(status) {
  return COMPLETED_PURCHASE_STATUSES.has(String(status || "").toLowerCase());
}

export function isIncompletePurchaseStatus(status) {
  return INCOMPLETE_PURCHASE_STATUSES.has(String(status || "").toLowerCase());
}

export function isFailedPurchaseStatus(status) {
  return FAILED_PURCHASE_STATUSES.has(String(status || "").toLowerCase());
}

async function findMaterial(db, materialId) {
  const materials = db.collection("materials");
  const byMaterialId = await materials.findOne({ materialId });
  if (byMaterialId) return byMaterialId;

  if (!/^[a-f\d]{24}$/i.test(String(materialId))) return null;
  const { ObjectId } = await import("mongodb");
  return materials.findOne({ _id: new ObjectId(materialId) });
}

async function findPurchase(db, materialId, buyerAddress) {
  const purchases = db.collection("purchases");
  const normalised = normalizeBuyerAddress(buyerAddress);
  const direct = await purchases.findOne({ materialId, buyerAddress: normalised });
  if (direct) return direct;

  if (normalised === buyerAddress) return null;
  return purchases.findOne({ materialId, buyerAddress });
}

function isOwner(material, buyerAddress) {
  const buyer = normalizeBuyerAddress(buyerAddress);
  return [material?.userAddress, material?.ownerAddress, material?.creatorAddress]
    .filter(Boolean)
    .some((address) => normalizeBuyerAddress(address) === buyer);
}

function isFreePublicMaterial(material) {
  const price = Number(material?.price || 0);
  return price <= 0 && material?.visibility === "public";
}

export async function getMaterialAccessStatus(db, materialId, buyerAddress) {
  if (!materialId || !buyerAddress) {
    return { error: "Missing materialId or buyerAddress", statusCode: 400 };
  }

  const material = await findMaterial(db, materialId);
  if (!material) {
    return {
      status: "unavailable",
      hasAccess: false,
      accessGranted: false,
      detail: "material not found",
    };
  }

  if (isOwner(material, buyerAddress)) {
    return {
      status: "active",
      hasAccess: true,
      accessGranted: true,
      source: "owner",
    };
  }

  if (isFreePublicMaterial(material)) {
    return {
      status: "active",
      hasAccess: true,
      accessGranted: true,
      source: "free-public",
    };
  }

  const purchase = await findPurchase(db, materialId, buyerAddress);
  if (!purchase) {
    return {
      status: "not_purchased",
      hasAccess: false,
      accessGranted: false,
      paymentRequired: Number(material.price || 0) > 0,
      source: "not-found",
    };
  }

  if (isCompletedPurchaseStatus(purchase.status)) {
    return {
      status: "active",
      hasAccess: true,
      accessGranted: true,
      source: "purchases-db",
      purchaseStatus: purchase.status,
      entitlement: purchase,
    };
  }

  if (isFailedPurchaseStatus(purchase.status)) {
    return {
      status: "payment_failed",
      hasAccess: false,
      accessGranted: false,
      source: "purchases-db",
      purchaseStatus: purchase.status,
      entitlement: purchase,
    };
  }

  return {
    status: "pending",
    hasAccess: false,
    accessGranted: false,
    source: "purchases-db",
    purchaseStatus: purchase.status || "pending",
    entitlement: purchase,
  };
}

export async function createPendingAccessRequest(db, materialId, buyerAddress, details = {}) {
  const current = await getMaterialAccessStatus(db, materialId, buyerAddress);
  if (current.statusCode || current.status === "unavailable" || current.hasAccess) {
    return current;
  }

  const normalised = normalizeBuyerAddress(buyerAddress);
  const now = new Date();

  const update = {
    $set: {
      materialId,
      buyerAddress: normalised,
      status: "pending",
      amount: details.amount ?? null,
      asset: details.asset ?? null,
      userEmail: details.email || null,
      accessRequestedAt: now,
      updatedAt: now,
    },
    $setOnInsert: {
      createdAt: now,
      purchasedAt: null,
      transactionHash: null,
      signedXdr: null,
    },
  };

  await db
    .collection("purchases")
    .updateOne({ materialId, buyerAddress: normalised }, update, { upsert: true });

  return {
    status: "pending",
    hasAccess: false,
    accessGranted: false,
    source: "access-request",
    purchaseStatus: "pending",
  };
}
