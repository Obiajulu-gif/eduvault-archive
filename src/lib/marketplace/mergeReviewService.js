/**
 * Authorized, deterministic duplicate merge review (#1085).
 *
 * `mergeReviewWorkflow.js` holds the state machine and the reversible merge
 * mechanics. This layer is the entry point API routes, operator tooling and
 * scripts should call. It adds the guarantees the workflow alone cannot give:
 *
 *   authorization      Deciding, merging and reversing each need a catalog
 *                      permission (admins hold all of them via `*`).
 *   conflict of        The creator of either material may not decide on, merge
 *   interest           or reverse their own duplicate case.
 *   four-eyes          Optional (`requireSeparateMerger`): whoever approved a
 *                      review may not also execute the merge.
 *   stale review       Approval pins the content fingerprints of both materials.
 *                      If either material changes before the merge runs, the
 *                      merge is refused (409) and the review must be re-decided
 *                      — a merge only ever applies to what a reviewer saw.
 *   determinism        Re-detection of the same catalog yields the same pairs,
 *                      scores and review ids (`rev-<canonical>-<duplicate>`),
 *                      so queueing is idempotent; see `queueDuplicateCandidates`.
 *   retry              Every command is idempotent: deciding the same decision
 *                      twice, merging an already merged review, or resuming an
 *                      interrupted merge returns the same outcome.
 */

import { hasPermission } from "../auth/permissions.js";
import { computeContentFingerprint, detectDuplicates } from "./duplicateDetection.js";
import {
  REVIEW_STATUS,
  createMergeReview,
  executeMerge,
  reverseMerge,
  updateReviewDecision,
} from "./mergeReviewWorkflow.js";

export const MERGE_REVIEW_PERMISSIONS = Object.freeze({
  DECIDE: "catalog:merge:review",
  EXECUTE: "catalog:merge:execute",
  REVERSE: "catalog:merge:reverse",
});

export class MergeReviewError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "MergeReviewError";
    this.code = code;
    this.status = status;
  }
}

// `userAddress` is the creator wallet on catalog `materials` documents.
const CREATOR_FIELDS = ["userAddress", "creator", "creatorId", "creatorAddress", "ownerId", "owner"];

function actorIdOf(actor) {
  if (!actor || typeof actor !== "object") return null;
  const id = actor.id ?? actor.userId ?? actor.walletAddress ?? null;
  return id === null || id === undefined || String(id).trim() === "" ? null : String(id);
}

function normalizeIdentity(value) {
  return value === null || value === undefined ? "" : String(value).trim().toLowerCase();
}

function assertPermitted(actor, permission) {
  if (!actorIdOf(actor) || !hasPermission(actor, permission)) {
    throw new MergeReviewError("MERGE_REVIEW_FORBIDDEN", `Permission ${permission} is required`, 403);
  }
}

async function loadReview(db, reviewId) {
  if (typeof reviewId !== "string" || !reviewId) {
    throw new MergeReviewError("MERGE_REVIEW_INVALID", "reviewId is required", 400);
  }
  const review = await db.collection("duplicate_merge_reviews").findOne({ reviewId });
  if (!review) throw new MergeReviewError("MERGE_REVIEW_NOT_FOUND", `Review record not found: ${reviewId}`, 404);
  return review;
}

async function loadMaterials(db, review) {
  const materials = db.collection("materials");
  const find = (id) => materials.findOne({ $or: [{ materialId: id }, { _id: id }] });
  const [canonical, duplicate] = await Promise.all([find(review.canonicalId), find(review.duplicateId)]);
  if (!canonical || !duplicate) {
    throw new MergeReviewError(
      "MERGE_REVIEW_MATERIAL_MISSING",
      `Material missing for review ${review.reviewId} (${!canonical ? review.canonicalId : review.duplicateId})`,
      409
    );
  }
  return { canonical, duplicate };
}

function assertNoConflictOfInterest(actor, materials) {
  const id = normalizeIdentity(actorIdOf(actor));
  const ownIdentities = new Set([id, normalizeIdentity(actor.walletAddress)].filter(Boolean));
  for (const material of [materials.canonical, materials.duplicate]) {
    for (const field of CREATOR_FIELDS) {
      if (ownIdentities.has(normalizeIdentity(material[field]))) {
        throw new MergeReviewError(
          "MERGE_REVIEW_CONFLICT_OF_INTEREST",
          "A creator may not review, merge or reverse a duplicate case involving their own material",
          403
        );
      }
    }
  }
}

function isHalfMerged(review, materials) {
  return (
    Boolean(review.mergeInProgress) &&
    materials.duplicate.status === "merged" &&
    materials.duplicate.mergeReviewId === review.reviewId
  );
}

function fingerprints(materials) {
  return {
    canonical: computeContentFingerprint(materials.canonical),
    duplicate: computeContentFingerprint(materials.duplicate),
  };
}

/**
 * Deterministically detect duplicates in `materials` and queue a review for
 * each candidate pair. Re-running over the same catalog returns the existing
 * reviews (same ids) instead of creating new ones.
 */
export async function queueDuplicateCandidates({ db, materials, actor, threshold, now } = {}) {
  assertPermitted(actor, MERGE_REVIEW_PERMISSIONS.DECIDE);
  const candidates = detectDuplicates(materials, { threshold, now });
  const reviews = [];
  for (const candidate of candidates) {
    reviews.push(await createMergeReview(db, candidate, actorIdOf(actor)));
  }
  return { candidates, reviews };
}

/**
 * Record a reviewer decision (APPROVED, REJECTED, or back to PENDING_REVIEW).
 * Approval pins both materials' fingerprints for the stale check at merge time.
 * Repeating the current decision is a no-op (safe client retry).
 */
export async function decideMergeReview({ db, actor, reviewId, decision, notes = "" } = {}) {
  assertPermitted(actor, MERGE_REVIEW_PERMISSIONS.DECIDE);
  const allowed = [REVIEW_STATUS.APPROVED, REVIEW_STATUS.REJECTED, REVIEW_STATUS.PENDING_REVIEW];
  if (!allowed.includes(decision)) {
    throw new MergeReviewError("MERGE_REVIEW_INVALID_DECISION", `Invalid review decision: ${decision}`, 400);
  }
  if (decision === REVIEW_STATUS.REJECTED && !String(notes || "").trim()) {
    throw new MergeReviewError("MERGE_REVIEW_NOTES_REQUIRED", "A rejection must explain why the records are distinct", 400);
  }

  const review = await loadReview(db, reviewId);
  if (review.status === REVIEW_STATUS.MERGED) {
    throw new MergeReviewError("MERGE_REVIEW_LOCKED", "A merged review must be reversed before it can be re-decided", 409);
  }
  const materials = await loadMaterials(db, review);
  // Half-merged (duplicate already pointed at the canonical by this review):
  // only finishing the merge (or reversing it afterwards) is safe.
  if (isHalfMerged(review, materials)) {
    throw new MergeReviewError("MERGE_REVIEW_LOCKED", "An interrupted merge must be completed with mergeApprovedDuplicate first", 409);
  }
  assertNoConflictOfInterest(actor, materials);

  const pinned = decision === REVIEW_STATUS.APPROVED ? fingerprints(materials) : null;
  if (
    review.status === decision &&
    review.reviewedBy === actorIdOf(actor) &&
    JSON.stringify(review.approvedFingerprints ?? null) === JSON.stringify(pinned)
  ) {
    return { ...review, idempotent: true };
  }

  return updateReviewDecision(db, reviewId, decision, actorIdOf(actor), String(notes || "").slice(0, 2000), {
    approvedFingerprints: pinned,
    // A merge attempt that died before touching any material leaves a stale
    // in-progress snapshot behind; a new decision discards it.
    ...(review.mergeInProgress ? { mergeInProgress: false, snapshotBeforeMerge: null } : {}),
  });
}

/**
 * Execute an approved merge. Refuses when the review is not APPROVED, when
 * either material changed since approval (stale), or on conflict of interest.
 * Already merged → returns the merged result; interrupted merge → resumes.
 */
export async function mergeApprovedDuplicate({ db, actor, reviewId, requireSeparateMerger = false } = {}) {
  assertPermitted(actor, MERGE_REVIEW_PERMISSIONS.EXECUTE);
  const review = await loadReview(db, reviewId);
  if (review.status === REVIEW_STATUS.MERGED) {
    return { success: true, reviewId, status: REVIEW_STATUS.MERGED, idempotent: true };
  }
  if (review.status !== REVIEW_STATUS.APPROVED) {
    throw new MergeReviewError(
      "MERGE_REVIEW_NOT_APPROVED",
      `Review ${reviewId} is ${review.status}; only APPROVED reviews can be merged`,
      409
    );
  }
  if (requireSeparateMerger && review.reviewedBy === actorIdOf(actor)) {
    throw new MergeReviewError("MERGE_REVIEW_SEPARATE_MERGER_REQUIRED", "The approver may not also execute the merge", 403);
  }

  const materials = await loadMaterials(db, review);
  assertNoConflictOfInterest(actor, materials);

  // An interrupted merge has already mutated the duplicate, so its live
  // fingerprint no longer matches; the snapshot taken under the approval is
  // what the reviewer saw. Otherwise compare against the live documents.
  const current = isHalfMerged(review, materials) && review.snapshotBeforeMerge
    ? fingerprints({ canonical: review.snapshotBeforeMerge.canonical, duplicate: review.snapshotBeforeMerge.duplicate })
    : fingerprints(materials);
  const pinned = review.approvedFingerprints;
  if (!pinned || pinned.canonical !== current.canonical || pinned.duplicate !== current.duplicate) {
    throw new MergeReviewError(
      "MERGE_REVIEW_STALE",
      "A material changed after this review was approved; re-review before merging",
      409
    );
  }

  const result = await executeMerge(db, reviewId, actorIdOf(actor));
  return { ...result, status: REVIEW_STATUS.MERGED };
}

/** Reverse a merge (e.g. disputed by a creator). A reason is mandatory. */
export async function reverseMergedDuplicate({ db, actor, reviewId, reason } = {}) {
  assertPermitted(actor, MERGE_REVIEW_PERMISSIONS.REVERSE);
  if (!reason || !String(reason).trim()) {
    throw new MergeReviewError("MERGE_REVIEW_REASON_REQUIRED", "A reversal reason is required", 400);
  }
  const review = await loadReview(db, reviewId);
  if (review.status === REVIEW_STATUS.REVERSED) {
    return { success: true, reviewId, status: REVIEW_STATUS.REVERSED, idempotent: true };
  }
  if (review.status !== REVIEW_STATUS.MERGED) {
    throw new MergeReviewError("MERGE_REVIEW_NOT_MERGED", `Review ${reviewId} is ${review.status}; nothing to reverse`, 409);
  }
  const materials = await loadMaterials(db, review);
  assertNoConflictOfInterest(actor, materials);
  return reverseMerge(db, reviewId, actorIdOf(actor), String(reason).slice(0, 2000));
}
