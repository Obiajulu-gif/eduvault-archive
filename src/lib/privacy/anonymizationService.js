/**
 * Anonymization Layer
 *
 * Replaces PII fields in "anonymize" collections with deterministic
 * placeholders while preserving referential integrity.
 *
 * All operations are idempotent:  running them twice on an already-anonymized
 * record is a no-op (the placeholder is never treated as real PII).
 */

import { getDb } from "@/lib/mongodb.js";
import {
  collectionsToAnonymize,
  ANONYMIZED_WALLET,
  ANONYMIZED_EMAIL,
  ANONYMIZED_NAME,
  ANONYMIZED_TEXT,
  ANONYMIZED_CID,
} from "./retentionPolicy.js";

/**
 * Field-level anonymizers.
 * Add new patterns here as the schema evolves.
 */
const FIELD_ANONYMIZERS = {
  walletAddress:           () => ANONYMIZED_WALLET,
  walletAddressLower:      () => ANONYMIZED_WALLET,
  buyerAddress:            () => ANONYMIZED_WALLET,
  userAddress:             () => ANONYMIZED_WALLET,
  payoutWalletAddress:     () => ANONYMIZED_WALLET,
  payoutWalletAddressLower:() => ANONYMIZED_WALLET,
  creatorId:               () => "[deleted]",
  updatedBy:               () => ANONYMIZED_WALLET,
  email:                   () => ANONYMIZED_EMAIL,
  fullName:                () => ANONYMIZED_NAME,
  displayName:             () => ANONYMIZED_NAME,
  bio:                     () => ANONYMIZED_TEXT,
  avatarCid:               () => ANONYMIZED_CID,
  avatarUrl:               () => ANONYMIZED_CID,
  institution:             () => ANONYMIZED_TEXT,
  country:                 () => ANONYMIZED_TEXT,
  payoutNotes:             () => ANONYMIZED_TEXT,
};

/**
 * Compute the $set patch for a given anonymizeMap.
 */
function buildAnonymizePatch(anonymizeMap) {
  const patch = {};
  for (const field of Object.keys(anonymizeMap)) {
    const fn = FIELD_ANONYMIZERS[field];
    patch[field] = fn ? fn() : "[redacted]";
  }
  patch._anonymizedAt = new Date();
  return patch;
}

/**
 * Anonymize all records in "anonymize" collections belonging to this user.
 *
 * @param {string} userId
 * @param {string|null} walletAddress
 * @returns {Record<string, number>} counts of modified docs per collection
 */
export async function anonymizeUserData(userId, walletAddress) {
  const db = await getDb();
  const results = {};

  const targets = collectionsToAnonymize();

  for (const { collection, anonymizeMap } of targets) {
    if (Object.keys(anonymizeMap).length === 0) {
      results[collection] = 0;
      continue;
    }

    const filter = buildOwnerFilter(collection, userId, walletAddress);
    if (!filter) {
      results[collection] = 0;
      continue;
    }

    // Skip documents that have already been anonymized
    const extendedFilter = { ...filter, _anonymizedAt: { $exists: false } };

    try {
      const patch = buildAnonymizePatch(anonymizeMap);
      const result = await db.collection(collection).updateMany(
        extendedFilter,
        { $set: patch }
      );
      results[collection] = result.modifiedCount;
    } catch (err) {
      // Don't abort the whole run; record the error and continue
      results[collection] = { error: err.message };
    }
  }

  return results;
}

/**
 * Build the ownership filter for each collection.
 * Returns null if the collection has no applicable predicate.
 */
function buildOwnerFilter(collection, userId, wallet) {
  switch (collection) {
    case "materials":
      return wallet
        ? { $or: [{ userAddress: wallet }, { walletAddress: wallet }] }
        : null;
    case "purchases":
      return wallet ? { buyerAddress: wallet } : null;
    case "entitlement_cache":
      return wallet ? { buyerAddress: wallet } : null;
    case "reviews":
      return wallet ? { walletAddress: wallet } : null;
    case "material_history":
      return wallet ? { updatedBy: wallet } : null;
    default:
      return null;
  }
}
