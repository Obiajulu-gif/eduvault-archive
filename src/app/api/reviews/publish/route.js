export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { auditLog } from "@/lib/api/audit";
import { getUserFromCookie } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { cacheDel } from "@/lib/cache/redis";
import {
  FEEDBACK_COLLECTION,
  sanitizeFeedback,
  summarizeFeedback,
  validateFeedbackPayload,
  isCreatorFeedback,
  feedbackModerationPlaceholder,
} from "@/lib/backend/materialFeedback";

export const runtime = "nodejs";

async function getReviewerAddress(db, user) {
  let address = user?.walletAddress || user?.address || user?.walletAddressLower || user?.id || "";
  if (!address && user?.sub && ObjectId.isValid(user.sub)) {
    const dbUser = await db.collection("users").findOne({ _id: new ObjectId(user.sub) });
    address = dbUser?.walletAddress || dbUser?.address || dbUser?.walletAddressLower || "";
  }
  return typeof address === "string" ? address.trim() : "";
}

/**
 * Recalculates and writes the cached averageRating and reviewCount on the
 * creator's user document. Called after every review is published so that
 * creator profile queries never need to aggregate feedback at read time.
 */
async function updateCreatorReviewCache(db, creatorAddress) {
  if (!creatorAddress) return;

  const creatorMaterials = await db
    .collection("materials")
    .find({ userAddress: creatorAddress, visibility: "public" }, { projection: { _id: 1 } })
    .toArray();

  if (!creatorMaterials.length) return;

  const materialIds = creatorMaterials.map((m) => m._id.toString());
  const objectIds = creatorMaterials.map((m) => m._id);

  const feedbackItems = await db
    .collection(FEEDBACK_COLLECTION)
    .find({
      $or: [
        { materialId: { $in: materialIds } },
        { materialObjectId: { $in: objectIds } },
      ],
      status: { $ne: "hidden" },
      moderationStatus: { $ne: "rejected" },
    })
    .toArray();

  const { averageScore: averageRating, feedbackCount: reviewCount } = summarizeFeedback(feedbackItems);

  await db.collection("users").updateOne(
    { $or: [{ walletAddress: creatorAddress }, { walletAddressLower: creatorAddress.toLowerCase() }] },
    { $set: { averageRating, reviewCount, updatedAt: new Date().toISOString() } }
  );
}

/**
 * POST /api/reviews/publish
 * Body: { materialId, score, comment? }
 *
 * Publishes a review for a public material and synchronously updates the
 * creator's cached averageRating and reviewCount. Upserts on (materialId,
 * reviewerAddress) so re-submitting a review replaces the previous one.
 */
export async function POST(request) {
  return withApiHardening(
    request,
    { route: "reviews.publish", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      try {
        const user = await getUserFromCookie(request);
        if (!user) {
          auditLog({ event: "auth_failed", route: "reviews.publish", method: "POST", status: 401 });
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await request.json();
        const { materialId } = body;

        if (!materialId || !ObjectId.isValid(materialId)) {
          return NextResponse.json({ error: "Invalid materialId" }, { status: 400 });
        }

        const payload = validateFeedbackPayload(body);
        const db = await getDb();

        const material = await db.collection("materials").findOne({
          _id: new ObjectId(materialId),
          visibility: "public",
        });

        if (!material) {
          return NextResponse.json({ error: "Material not found" }, { status: 404 });
        }

        const reviewerAddress = await getReviewerAddress(db, user);
        if (!reviewerAddress) {
          return NextResponse.json(
            { error: "A wallet address is required to publish a review." },
            { status: 400 }
          );
        }

        if (isCreatorFeedback(material, reviewerAddress)) {
          auditLog({ event: "creator_review_blocked", route: "reviews.publish", method: "POST", status: 403, actor: user.sub, materialId });
          return NextResponse.json({ error: "Creators cannot review their own material." }, { status: 403 });
        }

        const now = new Date();
        const materialObjectId = new ObjectId(materialId);
        const feedbackDoc = {
          materialId,
          materialObjectId,
          score: payload.score,
          rating: payload.score,
          comment: payload.comment,
          reviewerAddress,
          reviewerId: user.sub || user.id || null,
          reviewerName: user.name || "",
          verifiedBuyer: false,
          moderationStatus: "pending_review",
          status: "published",
          updatedAt: now,
        };

        const result = await db.collection(FEEDBACK_COLLECTION).findOneAndUpdate(
          { materialId, reviewerAddress },
          { $set: feedbackDoc, $setOnInsert: { createdAt: now } },
          { upsert: true, returnDocument: "after" }
        );

        // Update material-level aggregates
        const allMaterialFeedback = await db
          .collection(FEEDBACK_COLLECTION)
          .find({
            $or: [{ materialId }, { materialObjectId }],
            status: { $ne: "hidden" },
            moderationStatus: { $ne: "rejected" },
          })
          .toArray();

        const { averageScore, feedbackCount } = summarizeFeedback(allMaterialFeedback);
        await db.collection("materials").updateOne(
          { _id: materialObjectId },
          { $set: { averageScore, rating: averageScore, feedbackCount, reviewsCount: feedbackCount, updatedAt: now } }
        );

        // Recalculate and cache the creator's aggregate review score
        const creatorAddress = material.userAddress ?? material.ownerAddress ?? null;
        await updateCreatorReviewCache(db, creatorAddress);

        // Bust the market-materials catalog cache so updated stats appear immediately
        await cacheDel("market-materials:");

        const savedFeedback = result || feedbackDoc;
        auditLog({ event: "review_published", route: "reviews.publish", method: "POST", status: 200, actor: user.sub, materialId });

        return NextResponse.json({
          feedback: sanitizeFeedback(savedFeedback),
          averageScore,
          feedbackCount,
          moderation: feedbackModerationPlaceholder(),
        });
      } catch (err) {
        if (err.name === "ValidationError") {
          return NextResponse.json({ error: err.message, details: err.details }, { status: 400 });
        }
        auditLog({ event: "review_publish_failed", route: "reviews.publish", method: "POST", status: 500, reason: err.message });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
