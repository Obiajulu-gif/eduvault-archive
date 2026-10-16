import crypto from "node:crypto";

export const DUPLICATE_SEVERITY = {
  NONE: "none",
  WARN: "warn",
  REVIEW: "review",
  BLOCK: "block",
};

const NEAR_DUPLICATE_THRESHOLD = 0.85;
const REVIEW_THRESHOLD = 0.6;
const MAX_TITLE_LENGTH = 200;

/**
 * Normalizes a title for deterministic comparison: lowercase, collapse
 * whitespace, strip punctuation, and trim. Titles that normalize to the
 * same string are exact textual duplicates.
 */
export function normalizeTitle(title) {
  if (!title || typeof title !== "string") return "";
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
}

/**
 * Tokenizes a normalized title into a sorted word set for Jaccard
 * similarity comparison.
 */
function tokenize(title) {
  const normalized = normalizeTitle(title);
  if (!normalized) return [];
  return [...new Set(normalized.split(" "))].sort();
}

/**
 * Computes Jaccard similarity between two titles: |A ∩ B| / |A ∪ B|.
 * Returns a value between 0 (completely different) and 1 (identical).
 */
export function titleSimilarity(titleA, titleB) {
  const tokensA = tokenize(titleA);
  const tokensB = tokenize(titleB);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const intersection = [...setA].filter((token) => setB.has(token)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

/**
 * Builds a deterministic duplicate key from canonical fields.
 * The same (normalizedTitle, storageKey) pair always produces the same key.
 */
export function buildDuplicateKey(normalizedTitle, storageKey) {
  const title = normalizeTitle(normalizedTitle);
  const storage = storageKey ? String(storageKey).trim().toLowerCase() : "";
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ title, storage }))
    .digest("hex");
}

/**
 * Detects duplicates for a user-submitted record.
 *
 * Strategy:
 * 1. Exact match on (normalizedTitle, storageKey) → BLOCK
 * 2. Exact match on storageKey alone (same file, different title) → BLOCK
 * 3. High title similarity (≥ 0.85) with same storageKey → BLOCK
 * 4. High title similarity (≥ 0.85) with different storageKey → REVIEW
 * 5. Moderate title similarity (≥ 0.6) → WARN
 * 6. Otherwise → NONE
 *
 * @param {object} params
 * @param {string} params.title - Submitted title
 * @param {string} params.storageKey - Content storage key/hash
 * @param {Array<{title: string, storageKey: string}>} params.existing - Existing records
 * @returns {{severity: string, matches: Array, duplicateKey: string}}
 */
export function detectDuplicate({ title, storageKey, existing = [] }) {
  const normalizedTitle = normalizeTitle(title);
  const duplicateKey = buildDuplicateKey(title, storageKey);
  const matches = [];

  if (!normalizedTitle && !storageKey) {
    return { severity: DUPLICATE_SEVERITY.NONE, matches, duplicateKey };
  }

  for (const record of existing) {
    const existingTitle = normalizeTitle(record.title);
    const existingStorage = record.storageKey ? String(record.storageKey).trim().toLowerCase() : "";

    // Exact duplicate: same normalized title AND same storage key
    if (normalizedTitle && existingTitle === normalizedTitle && storageKey && existingStorage === String(storageKey).trim().toLowerCase()) {
      matches.push({ record, reason: "exact_title_and_storage", similarity: 1 });
      continue;
    }

    // Same storage key (identical file) with different title
    if (storageKey && existingStorage === String(storageKey).trim().toLowerCase() && existingTitle !== normalizedTitle) {
      matches.push({ record, reason: "exact_storage_key", similarity: 1 });
      continue;
    }

    // Fuzzy title match
    const similarity = titleSimilarity(title, record.title);
    if (similarity >= NEAR_DUPLICATE_THRESHOLD) {
      matches.push({ record, reason: "near_title", similarity });
    } else if (similarity >= REVIEW_THRESHOLD) {
      matches.push({ record, reason: "possible_title", similarity });
    }
  }

  // Determine severity from the strongest match
  let severity = DUPLICATE_SEVERITY.NONE;
  for (const match of matches) {
    if (match.reason === "exact_title_and_storage" || match.reason === "exact_storage_key") {
      severity = DUPLICATE_SEVERITY.BLOCK;
      break;
    }
    if (match.reason === "near_title") {
      // Near-identical title: block if same file, review if different file
      const sameStorage = match.record.storageKey &&
        String(match.record.storageKey).trim().toLowerCase() === String(storageKey || "").trim().toLowerCase();
      severity = sameStorage ? DUPLICATE_SEVERITY.BLOCK : DUPLICATE_SEVERITY.REVIEW;
      break;
    }
    if (match.reason === "possible_title" && severity === DUPLICATE_SEVERITY.NONE) {
      severity = DUPLICATE_SEVERITY.WARN;
    }
  }

  return { severity, matches, duplicateKey };
}

/**
 * Creates a review record for ambiguous duplicate matches so a maintainer
 * can resolve them manually.
 *
 * @param {object} db - Database handle
 * @param {object} params
 * @param {string} params.submittedTitle - The submitted title
 * @param {string} params.submittedStorageKey - The submitted storage key
 * @param {Array} params.matches - Ambiguous matches from detectDuplicate
 * @param {string} params.submitterId - User who submitted the record
 * @returns {Promise<string>} Review case ID
 */
export async function createDuplicateReview(db, { submittedTitle, submittedStorageKey, matches, submitterId }) {
  const reviewId = crypto.randomUUID();
  await db.collection("duplicate_reviews").insertOne({
    _id: reviewId,
    submittedTitle,
    submittedStorageKey,
    matches: matches.map((m) => ({
      recordId: m.record._id || m.record.id,
      title: m.record.title,
      reason: m.reason,
      similarity: m.similarity,
    })),
    submitterId,
    status: "pending",
    createdAt: new Date(),
    resolvedAt: null,
    resolution: null,
    resolvedBy: null,
  });
  return reviewId;
}

/**
 * Resolves a duplicate review case.
 *
 * @param {object} db - Database handle
 * @param {string} reviewId - Review case ID
 * @param {string} resolution - 'duplicate' or 'allowed'
 * @param {string} reviewerId - Maintainer resolving the case
 * @returns {Promise<object|null>} Updated review record or null if not found
 */
export async function resolveDuplicateReview(db, reviewId, resolution, reviewerId) {
  if (!["duplicate", "allowed"].includes(resolution)) {
    throw new Error("Resolution must be 'duplicate' or 'allowed'");
  }
  const result = await db.collection("duplicate_reviews").findOneAndUpdate(
    { _id: reviewId, status: "pending" },
    {
      $set: {
        status: "resolved",
        resolution,
        resolvedBy: reviewerId,
        resolvedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );
  return result?.value || result || null;
}
