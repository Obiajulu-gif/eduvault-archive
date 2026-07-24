import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { validateAuth } from "@/lib/auth/session";

/**
 * POST /api/verification/student
 * Submit student verification application with documents
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
    const formData = await request.formData();

    // Extract form fields
    const walletAddress = formData.get("walletAddress");
    const fullName = formData.get("fullName");
    const email = formData.get("email");
    const institution = formData.get("institution");
    const studentId = formData.get("studentId");
    const expectedGraduation = formData.get("expectedGraduation");
    const document = formData.get("document");

    // Validate required fields
    if (
      !fullName ||
      !email ||
      !institution ||
      !studentId ||
      !expectedGraduation ||
      !document
    ) {
      return NextResponse.json(
        { error: "All fields are required" },
        { status: 400 },
      );
    }

    // Verify wallet address matches authenticated user
    if (walletAddress.toLowerCase() !== address.toLowerCase()) {
      return NextResponse.json(
        { error: "Wallet address mismatch" },
        { status: 403 },
      );
    }

    // Validate file size (5MB max)
    if (document.size > 5 * 1024 * 1024) {
      return NextResponse.json(
        { error: "File size exceeds 5MB limit" },
        { status: 400 },
      );
    }

    // Validate file type
    const validTypes = [
      "image/jpeg",
      "image/png",
      "image/jpg",
      "application/pdf",
    ];
    if (!validTypes.includes(document.type)) {
      return NextResponse.json(
        { error: "Invalid file type. Only JPG, PNG, and PDF are allowed" },
        { status: 400 },
      );
    }

    const db = await getDb();

    // Check for existing pending or approved verification
    const existingVerification = await db
      .collection("student_verifications")
      .findOne({
        walletAddress: address.toLowerCase(),
        status: { $in: ["pending", "approved"] },
      });

    if (existingVerification) {
      return NextResponse.json(
        {
          error:
            "You already have a pending or approved verification application",
          status: existingVerification.status,
        },
        { status: 409 },
      );
    }

    // Convert file to buffer for storage
    const bytes = await document.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Create verification record
    const verification = {
      walletAddress: address.toLowerCase(),
      fullName,
      email: email.toLowerCase(),
      institution,
      studentId,
      expectedGraduation,
      document: {
        filename: document.name,
        mimetype: document.type,
        size: document.size,
        data: buffer, // In production, upload to cloud storage instead
      },
      status: "pending",
      submittedAt: new Date(),
      reviewedAt: null,
      reviewedBy: null,
      reviewNotes: null,
      verificationExpiry: null,
    };

    const result = await db
      .collection("student_verifications")
      .insertOne(verification);

    // Create admin moderation queue entry
    await db.collection("admin_moderation_queue").insertOne({
      type: "student_verification",
      verificationId: result.insertedId,
      walletAddress: address.toLowerCase(),
      submittedAt: new Date(),
      status: "pending",
      priority: "normal",
    });

    return NextResponse.json(
      {
        success: true,
        verificationId: result.insertedId.toString(),
        message: "Verification application submitted successfully",
        status: "pending",
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Error submitting student verification:", error);
    return NextResponse.json(
      { error: "Failed to submit verification", details: error.message },
      { status: 500 },
    );
  }
}

/**
 * GET /api/verification/student
 * Check student verification status for authenticated user
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
    const db = await getDb();

    const verification = await db.collection("student_verifications").findOne(
      { walletAddress: address.toLowerCase() },
      {
        projection: {
          "document.data": 0, // Exclude binary document data
        },
        sort: { submittedAt: -1 },
      },
    );

    if (!verification) {
      return NextResponse.json({
        success: true,
        verified: false,
        status: "not_applied",
      });
    }

    return NextResponse.json({
      success: true,
      verified: verification.status === "approved",
      status: verification.status,
      verification: {
        ...verification,
        _id: verification._id.toString(),
      },
    });
  } catch (error) {
    console.error("Error checking verification status:", error);
    return NextResponse.json(
      { error: "Failed to check verification status", details: error.message },
      { status: 500 },
    );
  }
}
