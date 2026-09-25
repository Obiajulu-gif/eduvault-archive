export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import { cacheDel } from "@/lib/cache/redis";

export const runtime = "nodejs";

function validateReviewBody(body) {
  const { materialId, reviewerAddress, rating, comment } = body ?? {};

  if (!materialId || typeof materialId !== "string") {
    return "materialId is required and must be a string";
  }
  if (!ObjectId.isValid(materialId)) {
    return "materialId must be a valid MongoDB ObjectId";
  }
  if (!reviewerAddress || typeof reviewerAddress !== "string") {
    return "reviewerAddress is required and must be a string";
  }
  const r = Number(rating);
  if (!Number.isFinite(r) || r < 1 || r > 5) {
    return "rating is required and must be a number between 1 and 5";
  }
  if (comment !== undefined && typeof comment !== "string") {
    return "comment must be a string";
  }
  return null;
}

// POST /api/reviews/publish
// Saves a review, updates the material's averageRating / reviewCount,
// and busts the market-materials cache for catalog listings.
export async function POST(request) {
  return withApiHardening(
    request,
    { route: "reviews-publish", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      let body;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      }

      const validationError = validateReviewBody(body);
      if (validationError) {
        return NextResponse.json({ error: validationError }, { status: 400 });
      }

      const { materialId, reviewerAddress, rating, comment } = body;
      const ratingNum = Number(rating);

      try {
        const db = await getDb();

        // 1. Verify the material exists and is public
        const material = await db.collection("materials").findOne({
          _id: new ObjectId(materialId),
          visibility: "public",
        });

        if (!material) {
          return NextResponse.json({ error: "Material not found" }, { status: 404 });
        }

        // 2. Save the review
        const review = {
          materialId,
          reviewerAddress,
          rating: ratingNum,
          comment: comment ?? "",
          createdAt: new Date(),
        };

        const insertResult = await db.collection("reviews").insertOne(review);

        // 3. Recalculate averageRating and reviewCount from all reviews for this material
        const aggregation = await db
          .collection("reviews")
          .aggregate([
            { $match: { materialId } },
            {
              $group: {
                _id: "$materialId",
                averageRating: { $avg: "$rating" },
                reviewCount: { $sum: 1 },
              },
            },
          ])
          .toArray();

        const stats = aggregation[0] ?? { averageRating: ratingNum, reviewCount: 1 };
        const averageRating = Math.round(stats.averageRating * 100) / 100;
        const reviewCount = stats.reviewCount;

        // 4. Update the material document with recalculated stats
        await db.collection("materials").updateOne(
          { _id: new ObjectId(materialId) },
          { $set: { averageRating, reviewCount, updatedAt: new Date() } }
        );

        // 5. Bust the market-materials catalog cache (root list key)
        await cacheDel("market-materials:");

        auditLog({
          event: "review_published",
          route: "reviews-publish",
          method: "POST",
          status: 201,
          materialId,
          actor: reviewerAddress,
        });

        return NextResponse.json(
          { ...review, _id: insertResult.insertedId },
          { status: 201 }
        );
      } catch (err) {
        auditLog({
          event: "review_publish_failed",
          route: "reviews-publish",
          method: "POST",
          status: 500,
          reason: err.message,
        });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
