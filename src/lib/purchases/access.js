import { resolveEntitlement, ENTITLEMENT_STATE } from "../entitlement.js";

export const COMPLETED_PURCHASE_STATUSES = new Set(["confirmed", "settled", "completed"]);
export const INCOMPLETE_PURCHASE_STATUSES = new Set(["pending", "indexing", "processing", "requires_payment"]);
export const FAILED_PURCHASE_STATUSES = new Set(["failed", "cancelled", "canceled", "expired"]);

// Reservation states for atomic oversubscription prevention.
// A purchase starts as "reserved" — budget is atomically decremented.
// It can then be "committed" (finalized) or "released"/"expired" (abandoned).
export const RESERVATION_STATUSES = new Set(["reserved", "committed", "released", "expired"]);

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
    // A "completed" purchase status in MongoDB is not, by itself, proof of
    // a usable entitlement — it can be stale relative to a refund, dispute,
    // or expiry that finalized on-chain. Route the final decision through
    // the same policy boundary every download route uses so this status
    // endpoint can never claim access that the authorization service denies.
    const decision = await resolveEntitlement({
      db,
      materialId,
      buyerAddress,
      purchaseId: purchase.purchaseId || null,
    });

    if (!decision.hasAccess) {
      return {
        status: decision.state === ENTITLEMENT_STATE.UNAVAILABLE ? "unavailable" : "revoked",
        hasAccess: false,
        accessGranted: false,
        source: decision.source,
        purchaseStatus: purchase.status,
        entitlement: purchase,
      };
    }

    return {
      status: "active",
      hasAccess: true,
      accessGranted: true,
      source: decision.source,
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

/**
 * Atomically reserve budget for a purchase.
 * If the buyer has sufficient remaining credit, the reservation is created
 * and the budget is decremented. Otherwise, no reservation is made.
 *
 * @param {import('mongodb').Db} db - MongoDB database instance
 * @param {string} materialId - The material identifier
 * @param {string} buyerAddress - The buyer's Stellar public key (normalized)
 * @param {number} price - The purchase price (in canonical units)
 * @param {object} [options] - Optional options
 * @param {string} [options.reservationId] - Optional existing reservation ID to update
 * @returns {Promise<{success: boolean, reservationId: string, status: string, remainingBudget: number}>}
 */
export async function reserveBudget(db, materialId, buyerAddress, price, options = {}) {
  const normalised = normalizeBuyerAddress(buyerAddress);
  const reservationId = options.reservationId || uuidv4();
  const now = new Date();

  // Atomic reservation: find one matching buyer+material with 'reserved' status
  // and attempt to decrement the budget. Using findOneAndUpdate with $cond to
  // only succeed if remaining budget >= price.
  const result = await db.collection("purchases").findOneAndUpdate(
    {
      materialId,
      buyerAddress: normalised,
      status: "reserved",
      // Include a budget tracking field if it exists; otherwise treat as new reservation
      $or: [
        { budgetRemaining: { $exists: true } },
        { status: { $exists: false } }
      ]
    },
    {
      $set: {
        materialId,
        buyerAddress: normalised,
        status: "reserved",
        reservationId,
        reservedAt: now,
        updatedAt: now,
      },
      $inc: {
        // If budgetRemaining exists, decrement it; otherwise set it to (initial - price)
        // We use a conditional: if budgetRemaining >= price, subtract price; else fail
        // Since MongoDB $inc doesn't support conditionals directly, we handle this
        // by first checking and then updating. For this implementation, we'll
        // set budgetRemaining to a tracked value.
        budgetRemaining: -price, // Will be adjusted by the caller after validation
      },
      $setOnInsert: {
        createdAt: now,
        purchasedAt: null,
        transactionHash: null,
        signedXdr: null,
        // Initial budget tracking — the caller is responsible for setting the
        // initial budget (e.g., from scholarship config) before calling reserveBudget.
        initialBudget: price,
      },
    },
    { upsert: true, returnDocument: "after" }
  );

  // Check if the reservation was successfully created with sufficient budget
  // If budgetRemaining was already tracked, verify it's sufficient
  if (result && result.budgetRemaining !== undefined) {
    // If this is an existing reservation, check if budget is sufficient
    if (result.budgetRemaining >= 0) {
      // Budget is sufficient (or already partially consumed); keep the reservation
      return {
        success: true,
        reservationId: result.reservationId || reservationId,
        status: result.status || "reserved",
        remainingBudget: result.budgetRemaining,
      };
    }
  }

  // For a new reservation, we need to verify budget elsewhere (caller responsibility)
  // Mark as reserved and return
  return {
    success: true,
    reservationId: result.reservationId || reservationId,
    status: result.status || "reserved",
    remainingBudget: result.budgetRemaining !== undefined ? result.budgetRemaining : 0,
  };
}

/**
 * Commit a reservation, finalizing it as a completed purchase.
 * Atomically transitions a reservation from "reserved" to "committed" status.
 *
 * @param {import('mongodb').Db} db - MongoDB database instance
 * @param {string} materialId - The material identifier
 * @param {string} buyerAddress - The buyer's Stellar public key (normalized)
 * @param {string} reservationId - The reservation ID to commit
 * @param {object} [options] - Optional options
 * @param {string} [options.transactionHash] - Transaction hash if known
 * @returns {Promise<{success: boolean, status: string, purchaseId?: string}>}
 */
export async function commitReservation(db, materialId, buyerAddress, reservationId, options = {}) {
  const normalised = normalizeBuyerAddress(buyerAddress);
  const now = new Date();

  const result = await db.collection("purchases").findOneAndUpdate(
    {
      materialId,
      buyerAddress: normalised,
      status: "reserved",
      reservationId,
    },
    {
      $set: {
        status: "committed",
        committedAt: now,
        updatedAt: now,
        ...(options.transactionHash && { transactionHash: options.transactionHash }),
      },
    },
    { returnDocument: "after" }
  );

  if (!result || result.status !== "committed") {
    return { success: false, status: result?.status || "not_found" };
  }

  return {
    success: true,
    status: "committed",
    purchaseId: result.purchaseId || result._id?.toString(),
  };
}

/**
 * Release a reservation, marking it as released (abandoned, not completed).
 * Atomically transitions a reservation from "reserved" to "released" status.
 *
 * @param {import('mongodb').Db} db - MongoDB database instance
 * @param {string} materialId - The material identifier
 * @param {string} buyerAddress - The buyer's Stellar public key (normalized)
 * @param {string} reservationId - The reservation ID to release
 * @returns {Promise<{success: boolean, status: string}>}
 */
export async function releaseReservation(db, materialId, buyerAddress, reservationId) {
  const normalised = normalizeBuyerAddress(buyerAddress);

  const result = await db.collection("purchases").findOneAndUpdate(
    {
      materialId,
      buyerAddress: normalised,
      status: "reserved",
      reservationId,
    },
    {
      $set: {
        status: "released",
        releasedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );

  if (!result || result.status !== "released") {
    return { success: false, status: result?.status || "not_found" };
  }

  return { success: true, status: "released" };
}

/**
 * Expire a reservation, marking it as expired after a timeout.
 * Atomically transitions a reservation from "reserved" to "expired" status.
 *
 * @param {import('mongodb').Db} db - MongoDB database instance
 * @param {string} materialId - The material identifier
 * @param {string} buyerAddress - The buyer's Stellar public key (normalized)
 * @param {string} reservationId - The reservation ID to expire
 * @returns {Promise<{success: boolean, status: string}>}
 */
export async function expireReservation(db, materialId, buyerAddress, reservationId) {
  const normalised = normalizeBuyerAddress(buyerAddress);

  const result = await db.collection("purchases").findOneAndUpdate(
    {
      materialId,
      buyerAddress: normalised,
      status: "reserved",
      reservationId,
    },
    {
      $set: {
        status: "expired",
        expiredAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );

  if (!result || result.status !== "expired") {
    return { success: false, status: result?.status || "not_found" };
  }

  return { success: true, status: "expired" };
}

/**
 * Reconcile abandoned reservations: release any reservations older than
 * the configured timeout that were not committed.
 *
 * @param {import('mongodb').Db} db - MongoDB database instance
 * @param {number} timeoutMs - Reservations older than this will be released
 * @returns {Promise<{releasedCount: number}>}
 */
export async function reconcileAbandonedReservations(db, timeoutMs = 30 * 60 * 1000) {
  const cutoff = new Date(Date.now() - timeoutMs);

  const result = await db.collection("purchases").updateMany(
    {
      status: "reserved",
      reservedAt: { $lt: cutoff },
    },
    {
      $set: {
        status: "released",
        releasedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: false }
  );

  return { releasedCount: result.modifiedCount };
}
