/**
 * Deterministic duplicate detection and authorized merge review — Issue #1085
 *
 * Normal path (detect → queue → approve → merge → reverse), determinism,
 * failure paths (stale approval, wrong state, missing material, invalid
 * input), retry paths (idempotent commands, interrupted merge resume, one
 * audit record per step), and authorization (permissions, conflict of
 * interest, four-eyes).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { detectDuplicates } from "../../src/lib/marketplace/duplicateDetection.js";
import {
  MergeReviewError,
  decideMergeReview,
  mergeApprovedDuplicate,
  queueDuplicateCandidates,
  reverseMergedDuplicate,
} from "../../src/lib/marketplace/mergeReviewService.js";
import { REVIEW_STATUS, executeMerge, resolveMergedMaterial } from "../../src/lib/marketplace/mergeReviewWorkflow.js";
import { createMemoryMongo } from "./helpers/memoryMongo.mjs";

const moderator = { id: "mod-alice", role: "admin" };
const operator = { id: "op-bob", role: "admin" };
const learner = { id: "learner-1", role: "learner" };
const creatorAdmin = { id: "GCREATOR", role: "admin" };
const fixedNow = () => new Date("2026-11-19T00:00:00.000Z");

const catalog = () => [
  { _id: "mat-a", materialId: "mat-a", title: "Intro to Calculus", description: "limits and derivatives", creator: "gcreator", tags: ["math"], status: "published", createdAt: "2026-01-01T00:00:00.000Z" },
  { _id: "mat-b", materialId: "mat-b", title: "Intro to Calculus", description: "limits and derivatives", creator: "GCREATOR", tags: ["math"], status: "published", createdAt: "2026-02-01T00:00:00.000Z" },
  { _id: "mat-c", materialId: "mat-c", title: "Organic Chemistry", description: "carbon", creator: "gother", tags: ["chem"], status: "published", createdAt: "2026-01-15T00:00:00.000Z" },
];

function setup() {
  const db = createMemoryMongo({ materials: catalog() });
  return db;
}

async function approvedReview(db = setup()) {
  const { reviews } = await queueDuplicateCandidates({ db, materials: catalog(), actor: moderator, now: fixedNow });
  const reviewId = reviews[0].reviewId;
  await decideMergeReview({ db, actor: moderator, reviewId, decision: REVIEW_STATUS.APPROVED, notes: "same lecture" });
  return { db, reviewId };
}

const auditActions = (db) => db.all("audit_ledger").map((r) => r.action);

describe("deterministic detection", () => {
  test("the same catalog yields identical candidates regardless of input order", () => {
    const forward = detectDuplicates(catalog(), { now: fixedNow });
    const reversed = detectDuplicates([...catalog()].reverse(), { now: fixedNow });
    assert.deepEqual(reversed, forward);
    assert.equal(forward.length, 1);
    assert.equal(forward[0].canonicalId, "mat-a", "the older record is canonical");
    assert.equal(forward[0].detectedAt, "2026-11-19T00:00:00.000Z");
  });

  test("unparseable createdAt values do not make the canonical choice order-dependent", () => {
    const items = [
      { materialId: "z-1", title: "Same Title", creator: "x", createdAt: "not-a-date" },
      { materialId: "a-1", title: "Same Title", creator: "x", createdAt: "also-bad" },
    ];
    const one = detectDuplicates(items, { now: fixedNow });
    const two = detectDuplicates([...items].reverse(), { now: fixedNow });
    assert.deepEqual(one, two);
    assert.equal(one[0].canonicalId, "a-1");
  });

  test("queueing twice is idempotent: same review ids, no duplicate reviews", async () => {
    const db = setup();
    const first = await queueDuplicateCandidates({ db, materials: catalog(), actor: moderator, now: fixedNow });
    const second = await queueDuplicateCandidates({ db, materials: [...catalog()].reverse(), actor: moderator, now: fixedNow });
    assert.deepEqual(second.reviews.map((r) => r.reviewId), first.reviews.map((r) => r.reviewId));
    assert.equal(db.all("duplicate_merge_reviews").length, 1);
    assert.deepEqual(auditActions(db), ["duplicate.detected"]);
  });
});

describe("normal path", () => {
  test("approve → merge → resolve → reverse, with one audit record per step", async () => {
    const { db, reviewId } = await approvedReview();
    const review = db.all("duplicate_merge_reviews")[0];
    assert.equal(review.status, REVIEW_STATUS.APPROVED);
    assert.match(review.approvedFingerprints.canonical, /^[0-9a-f]{64}$/);

    const merged = await mergeApprovedDuplicate({ db, actor: operator, reviewId });
    assert.equal(merged.status, REVIEW_STATUS.MERGED);
    assert.equal(merged.resumed, false);
    assert.deepEqual(await resolveMergedMaterial(db, "mat-b"), { resolvedId: "mat-a", isMerged: true, canonicalId: "mat-a" });
    assert.deepEqual(db.get("materials", "mat-a").aliases, ["mat-b"]);

    const reversed = await reverseMergedDuplicate({ db, actor: operator, reviewId, reason: "creator dispute" });
    assert.equal(reversed.status, REVIEW_STATUS.REVERSED);
    assert.equal(db.get("materials", "mat-b").status, "published");
    assert.deepEqual(db.get("materials", "mat-a").aliases, []);

    assert.deepEqual(auditActions(db), ["duplicate.detected", "duplicate.review_approved", "duplicate.merged", "duplicate.unmerged"]);
  });

  test("a reversed review can be re-approved and merged again with a fresh snapshot", async () => {
    const { db, reviewId } = await approvedReview();
    await mergeApprovedDuplicate({ db, actor: operator, reviewId });
    await reverseMergedDuplicate({ db, actor: operator, reviewId, reason: "check" });
    await decideMergeReview({ db, actor: moderator, reviewId, decision: REVIEW_STATUS.APPROVED, notes: "confirmed after check" });
    await mergeApprovedDuplicate({ db, actor: operator, reviewId });

    const review = db.all("duplicate_merge_reviews")[0];
    assert.equal(review.mergeCount, 2);
    assert.equal(review.snapshotBeforeMerge.duplicate.status, "published");
    const ops = db.all("audit_ledger").map((r) => r.operationId);
    assert.ok(ops.includes(`audit-${reviewId}-merged-1`) && ops.includes(`audit-${reviewId}-merged-2`));
  });
});

describe("failure paths", () => {
  test("a material edited after approval makes the review stale and blocks the merge", async () => {
    const { db, reviewId } = await approvedReview();
    db.put("materials", { ...db.get("materials", "mat-b"), description: "now a different chapter" });

    await assert.rejects(
      () => mergeApprovedDuplicate({ db, actor: operator, reviewId }),
      (e) => e instanceof MergeReviewError && e.code === "MERGE_REVIEW_STALE" && e.status === 409
    );
    assert.equal(db.get("materials", "mat-b").status, "published");

    // Re-review pins the new fingerprints and unblocks the merge.
    await decideMergeReview({ db, actor: moderator, reviewId, decision: REVIEW_STATUS.APPROVED, notes: "still a duplicate" });
    const merged = await mergeApprovedDuplicate({ db, actor: operator, reviewId });
    assert.equal(merged.status, REVIEW_STATUS.MERGED);
  });

  test("only APPROVED reviews merge; DETECTED is rejected even via the low-level workflow", async () => {
    const db = setup();
    const { reviews } = await queueDuplicateCandidates({ db, materials: catalog(), actor: moderator, now: fixedNow });
    await assert.rejects(() => mergeApprovedDuplicate({ db, actor: operator, reviewId: reviews[0].reviewId }), (e) => e.code === "MERGE_REVIEW_NOT_APPROVED");
    await assert.rejects(() => executeMerge(db, reviews[0].reviewId, "op-bob"), /APPROVED review is required/);
  });

  test("rejections need notes, decisions must be valid, and merged reviews are locked", async () => {
    const { db, reviewId } = await approvedReview();
    await assert.rejects(() => decideMergeReview({ db, actor: moderator, reviewId, decision: REVIEW_STATUS.REJECTED }), (e) => e.code === "MERGE_REVIEW_NOTES_REQUIRED");
    await assert.rejects(() => decideMergeReview({ db, actor: moderator, reviewId, decision: "MERGED" }), (e) => e.code === "MERGE_REVIEW_INVALID_DECISION");
    await mergeApprovedDuplicate({ db, actor: operator, reviewId });
    await assert.rejects(() => decideMergeReview({ db, actor: moderator, reviewId, decision: REVIEW_STATUS.REJECTED, notes: "x" }), (e) => e.code === "MERGE_REVIEW_LOCKED");
  });

  test("unknown reviews, missing materials and reversal without a reason fail cleanly", async () => {
    const { db, reviewId } = await approvedReview();
    await assert.rejects(() => mergeApprovedDuplicate({ db, actor: operator, reviewId: "rev-nope" }), (e) => e.status === 404);
    await assert.rejects(() => reverseMergedDuplicate({ db, actor: operator, reviewId, reason: "" }), (e) => e.code === "MERGE_REVIEW_REASON_REQUIRED");
    await assert.rejects(() => reverseMergedDuplicate({ db, actor: operator, reviewId, reason: "x" }), (e) => e.code === "MERGE_REVIEW_NOT_MERGED");

    const orphan = createMemoryMongo({ materials: [catalog()[0]] });
    await orphan.collection("duplicate_merge_reviews").insertOne({ reviewId: "rev-mat-a-mat-b", canonicalId: "mat-a", duplicateId: "mat-b", status: "DETECTED" });
    await assert.rejects(
      () => decideMergeReview({ db: orphan, actor: moderator, reviewId: "rev-mat-a-mat-b", decision: REVIEW_STATUS.APPROVED }),
      (e) => e.code === "MERGE_REVIEW_MATERIAL_MISSING"
    );
  });
});

describe("retry paths", () => {
  test("an interrupted merge resumes from the persisted snapshot and audits once", async () => {
    const { db, reviewId } = await approvedReview();
    // 1st materials.updateOne (mark duplicate merged) succeeds, 2nd (canonical alias) fails.
    let calls = 0;
    const materials = db.collection("materials");
    const realCollection = db.collection.bind(db);
    db.collection = (name) => {
      if (name !== "materials") return realCollection(name);
      return {
        ...materials,
        findOne: materials.findOne,
        async updateOne(query, update) {
          calls += 1;
          if (calls === 2) throw new Error("connection reset");
          return materials.updateOne(query, update);
        },
      };
    };
    await assert.rejects(() => mergeApprovedDuplicate({ db, actor: operator, reviewId }), /connection reset/);
    assert.equal(db.get("materials", "mat-b").status, "merged", "duplicate was already mutated");
    assert.equal(db.all("duplicate_merge_reviews")[0].mergeInProgress, true);

    // Other decisions are locked while the merge is half-done.
    await assert.rejects(() => decideMergeReview({ db, actor: moderator, reviewId, decision: REVIEW_STATUS.REJECTED, notes: "x" }), (e) => e.code === "MERGE_REVIEW_LOCKED");

    const resumed = await mergeApprovedDuplicate({ db, actor: operator, reviewId });
    assert.equal(resumed.resumed, true);
    const review = db.all("duplicate_merge_reviews")[0];
    assert.equal(review.status, REVIEW_STATUS.MERGED);
    assert.equal(review.snapshotBeforeMerge.duplicate.status, "published", "snapshot is the pre-merge state");
    assert.deepEqual(db.get("materials", "mat-a").aliases, ["mat-b"]);
    assert.equal(auditActions(db).filter((a) => a === "duplicate.merged").length, 1);

    // And the reversal restores the true pre-merge state.
    await reverseMergedDuplicate({ db, actor: operator, reviewId, reason: "verify rollback" });
    assert.equal(db.get("materials", "mat-b").status, "published");
  });

  test("a merge that died before touching materials is not stuck: re-decide or re-merge both work", async () => {
    const { db, reviewId } = await approvedReview();
    const materials = db.collection("materials");
    const realCollection = db.collection.bind(db);
    db.collection = (name) =>
      name === "materials"
        ? { ...materials, async updateOne() { throw new Error("primary stepped down"); } }
        : realCollection(name);
    await assert.rejects(() => mergeApprovedDuplicate({ db, actor: operator, reviewId }), /primary stepped down/);
    db.collection = realCollection;
    assert.equal(db.all("duplicate_merge_reviews")[0].mergeInProgress, true);
    assert.equal(db.get("materials", "mat-b").status, "published", "nothing was mutated");

    // The material changes meanwhile: the merge is stale, and re-deciding is allowed.
    db.put("materials", { ...db.get("materials", "mat-b"), description: "different now" });
    await assert.rejects(() => mergeApprovedDuplicate({ db, actor: operator, reviewId }), (e) => e.code === "MERGE_REVIEW_STALE");
    await decideMergeReview({ db, actor: moderator, reviewId, decision: REVIEW_STATUS.APPROVED, notes: "re-checked" });
    assert.equal(db.all("duplicate_merge_reviews")[0].mergeInProgress, false);

    await mergeApprovedDuplicate({ db, actor: operator, reviewId });
    const review = db.all("duplicate_merge_reviews")[0];
    assert.equal(review.snapshotBeforeMerge.duplicate.description, "different now", "a fresh snapshot is taken");
  });

  test("repeating a decision, a merge, or a reversal is a no-op", async () => {
    const { db, reviewId } = await approvedReview();
    const again = await decideMergeReview({ db, actor: moderator, reviewId, decision: REVIEW_STATUS.APPROVED, notes: "same lecture" });
    assert.equal(again.idempotent, true);

    await mergeApprovedDuplicate({ db, actor: operator, reviewId });
    assert.equal((await mergeApprovedDuplicate({ db, actor: operator, reviewId })).idempotent, true);
    await reverseMergedDuplicate({ db, actor: operator, reviewId, reason: "r" });
    assert.equal((await reverseMergedDuplicate({ db, actor: operator, reviewId, reason: "r" })).idempotent, true);

    assert.deepEqual(auditActions(db), ["duplicate.detected", "duplicate.review_approved", "duplicate.merged", "duplicate.unmerged"]);
  });
});

describe("authorization", () => {
  test("every command requires the catalog merge permissions and an identified actor", async () => {
    const { db, reviewId } = await approvedReview();
    for (const actor of [null, learner, { role: "admin" }, { id: "svc", role: "service" }]) {
      await assert.rejects(() => queueDuplicateCandidates({ db, materials: catalog(), actor }), (e) => e.status === 403);
      await assert.rejects(() => decideMergeReview({ db, actor, reviewId, decision: REVIEW_STATUS.APPROVED }), (e) => e.status === 403);
      await assert.rejects(() => mergeApprovedDuplicate({ db, actor, reviewId }), (e) => e.status === 403);
      await assert.rejects(() => reverseMergedDuplicate({ db, actor, reviewId, reason: "x" }), (e) => e.status === 403);
    }
    assert.equal(db.get("materials", "mat-b").status, "published");
  });

  test("a creator cannot decide, merge or reverse a case involving their own material", async () => {
    const { db, reviewId } = await approvedReview();
    // creator ids are compared case-insensitively ("gcreator" vs "GCREATOR").
    await assert.rejects(() => decideMergeReview({ db, actor: creatorAdmin, reviewId, decision: REVIEW_STATUS.REJECTED, notes: "mine" }), (e) => e.code === "MERGE_REVIEW_CONFLICT_OF_INTEREST");
    await assert.rejects(() => mergeApprovedDuplicate({ db, actor: creatorAdmin, reviewId }), (e) => e.code === "MERGE_REVIEW_CONFLICT_OF_INTEREST");
    await mergeApprovedDuplicate({ db, actor: operator, reviewId });
    await assert.rejects(() => reverseMergedDuplicate({ db, actor: creatorAdmin, reviewId, reason: "undo" }), (e) => e.code === "MERGE_REVIEW_CONFLICT_OF_INTEREST");
  });

  test("the catalog creator wallet (userAddress) also counts as a conflict of interest", async () => {
    const wallet = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
    const materials = catalog().map((m) => ({ ...m, creator: undefined, userAddress: wallet }));
    const db = createMemoryMongo({ materials });
    const { reviews } = await queueDuplicateCandidates({ db, materials, actor: moderator, now: fixedNow });
    await assert.rejects(
      () => decideMergeReview({ db, actor: { id: "admin-7", walletAddress: wallet.toLowerCase(), role: "admin" }, reviewId: reviews[0].reviewId, decision: REVIEW_STATUS.APPROVED }),
      (e) => e.code === "MERGE_REVIEW_CONFLICT_OF_INTEREST"
    );
  });

  test("requireSeparateMerger enforces four-eyes between approver and merger", async () => {
    const { db, reviewId } = await approvedReview();
    await assert.rejects(
      () => mergeApprovedDuplicate({ db, actor: moderator, reviewId, requireSeparateMerger: true }),
      (e) => e.code === "MERGE_REVIEW_SEPARATE_MERGER_REQUIRED"
    );
    const merged = await mergeApprovedDuplicate({ db, actor: operator, reviewId, requireSeparateMerger: true });
    assert.equal(merged.status, REVIEW_STATUS.MERGED);
  });
});
