import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { validateAuth } from "@/lib/auth/session";
import { ObjectId } from "mongodb";

/**
 * POST /api/reviews/report
 * Allows creators to flag reviews on their materials for moderation
 */
export async function POST(request) {
  try {
    // Authenticate user
    const authResult = await validateAuth(request);
    if (!authResult.valid) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const { address } = authResult;
    const body = await request.json();
    const { reviewId, materialId, reason, additionalDetails } = body;

    // Validate required fields
    if (!reviewId || !materialId || !reason) {
      return NextResponse.json(
        { error: "reviewId, materialId, and reason are required" },
        { status: 400 },
      );
    }

    // Validate reason
    const validReasons = ["spam", "abusive", "false", "inappropriate", "other"];
    if (!validReasons.includes(reason)) {
      return NextResponse.json(
        { error: `Invalid reason. Must be one of: ${validReasons.join(", ")}` },
        { status: 400 },
      );
    }

    const db = await getDb();

    // Verify the material exists and the reporter is the creator
    const material = await db.collection("materials").findOne({
      _id: new ObjectId(materialId),
    });

    if (!material) {
      return NextResponse.json(
        { error: "Material not found" },
        { status: 404 },
      );
    }

    // Check if the authenticated user is the creator of the material
    if (material.creator?.toLowerCase() !== address.toLowerCase()) {
      return NextResponse.json(
        {
          error:
            "Only the material creator can report reviews on their own materials",
        },
        { status: 403 },
      );
    }

    // Verify the review exists
    const review = await db.collection("reviews").findOne({
      _id: new ObjectId(reviewId),
      materialId: new ObjectId(materialId),
    });

    if (!review) {
      return NextResponse.json(
        { error: "Review not found for this material" },
        { status: 404 },
      );
    }

    // Check if this review has already been reported by this creator
    const existingReport = await db.collection("reported_reviews").findOne({
      reviewId: new ObjectId(reviewId),
      reportedBy: address.toLowerCase(),
    });

    if (existingReport) {
      return NextResponse.json(
        { error: "You have already reported this review" },
        { status: 409 },
      );
    }

    // Create moderation ticket
    const report = {
      reviewId: new ObjectId(reviewId),
      materialId: new ObjectId(materialId),
      materialTitle: material.title,
      reportedBy: address.toLowerCase(),
      reportedAt: new Date(),
      reason,
      additionalDetails: additionalDetails || null,
      status: "pending",
      reviewContent: {
        rating: review.rating,
        comment: review.comment,
        reviewedBy: review.reviewedBy,
        createdAt: review.createdAt,
      },
      moderationAction: null,
      moderatedBy: null,
      moderatedAt: null,
      notes: null,
    };

    const result = await db.collection("reported_reviews").insertOne(report);

    // Optionally increment a flag count on the review itself
    await db.collection("reviews").updateOne(
      { _id: new ObjectId(reviewId) },
      {
        $inc: { flagCount: 1 },
        $set: { lastFlaggedAt: new Date() },
      },
    );

    return NextResponse.json(
      {
        success: true,
        reportId: result.insertedId.toString(),
        message: "Review reported successfully and queued for moderation",
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Error reporting review:", error);
    return NextResponse.json(
      { error: "Failed to report review", details: error.message },
      { status: 500 },
    );
  }
}

/**
 * GET /api/reviews/report
 * Get reported reviews (admin only)
 */
export async function GET(request) {
  try {
    const authResult = await validateAuth(request);
    if (!authResult.valid) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const { address } = authResult;
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || "pending";

    const db = await getDb();

    // Check if user is admin (you'll need to implement admin check)
    // For now, we'll return reports created by the authenticated user
    const query = {
      reportedBy: address.toLowerCase(),
      ...(status !== "all" && { status }),
    };

    const reports = await db
      .collection("reported_reviews")
      .find(query)
      .sort({ reportedAt: -1 })
      .limit(50)
      .toArray();

    return NextResponse.json({
      success: true,
      reports: reports.map((r) => ({
        ...r,
        _id: r._id.toString(),
        reviewId: r.reviewId.toString(),
        materialId: r.materialId.toString(),
      })),
    });
  } catch (error) {
    console.error("Error fetching reported reviews:", error);
    return NextResponse.json(
      { error: "Failed to fetch reported reviews", details: error.message },
      { status: 500 },
    );
  }
}
