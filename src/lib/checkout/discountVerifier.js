import { marketplaceListings } from "../marketplace/listings.js";

let ObjectIdClass = null;
try {
  import("mongodb").then(m => {
    ObjectIdClass = m.ObjectId;
  }).catch(() => {});
} catch (e) {}

export async function findMaterial(materialId, db = null) {
  if (!materialId) return null;

  if (db || globalThis._mongoClientPromise) {
    try {
      const activeDb = db || (await (await import("../mongodb.js")).getDb());
      let doc = null;
      if (ObjectIdClass) {
        try {
          doc = await activeDb.collection("materials").findOne({ _id: new ObjectIdClass(materialId) });
        } catch (e) {}
      }
      if (!doc) {
        doc = await activeDb.collection("materials").findOne({ _id: materialId });
      }
      if (doc) {
        return {
          id: doc._id.toString(),
          title: doc.title,
          price: doc.price,
          userAddress: doc.userAddress || doc.authorAddress || null,
          creatorAddress: doc.userAddress || doc.authorAddress || null,
        };
      }
    } catch (e) {
      if (!db) {
        console.warn("Database lookup failed for material:", e?.message || e);
      }
    }
  }

  // Fallback to listings
  const listing = marketplaceListings.find((l) => l.id === materialId);
  if (listing) {
    let price = 0;
    if (typeof listing.price === "string") {
      price = parseFloat(listing.price.split(" ")[0]) || 0;
    } else if (typeof listing.price === "number") {
      price = listing.price;
    }
    return {
      id: listing.id,
      title: listing.title,
      price: price,
      userAddress: listing.userAddress || (listing.author && listing.author.walletAddress) || null,
      creatorAddress: listing.userAddress || (listing.author && listing.author.walletAddress) || null,
    };
  }

  return null;
}

export async function verifyDiscount(codeString, materialId, db = null) {
  if (!codeString || !materialId) {
    return { valid: false, reason: "Missing code or materialId" };
  }

  const cleanCode = String(codeString).trim().toUpperCase();

  let discount = null;
  try {
    const activeDb = db || (await (await import("../mongodb.js")).getDb());
    discount = await activeDb.collection("discount_codes").findOne({ code: cleanCode });
  } catch (e) {
    if (!db) {
      console.warn("Database lookup failed for discount code:", e?.message || e);
    }
  }

  if (!discount) {
    return { valid: false, reason: "Discount code not found" };
  }

  // 1. Check expiry date
  if (discount.expiresAt) {
    const expires = new Date(discount.expiresAt);
    if (isNaN(expires.getTime()) || expires < new Date()) {
      return { valid: false, reason: "Discount code expired" };
    }
  }

  // 2. Check usage limit
  const usageCount = discount.usageCount || 0;
  if (discount.usageLimit !== undefined && discount.usageLimit !== null) {
    if (usageCount >= discount.usageLimit) {
      return { valid: false, reason: "Discount code usage limit reached" };
    }
  }

  // 3. Check creator restriction
  const material = await findMaterial(materialId, db);
  if (!material) {
    return { valid: false, reason: "Material not found" };
  }

  if (discount.creatorAddress) {
    const materialCreator = (material.creatorAddress || material.userAddress || "").toLowerCase();
    const restrictionAddress = discount.creatorAddress.toLowerCase();
    if (materialCreator !== restrictionAddress) {
      return { valid: false, reason: "Discount code not valid for this creator's materials" };
    }
  }

  if (discount.materialId) {
    if (discount.materialId !== materialId) {
      return { valid: false, reason: "Discount code not valid for this material" };
    }
  }

  return {
    valid: true,
    discount,
    discountAmountPercent: discount.percentage || 0,
  };
}
