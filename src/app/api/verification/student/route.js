import { NextResponse } from "next/server";
import connectToDatabase from "@/lib/mongodb";
import { validateAuth } from "@/lib/auth/session";
import { withApiHardening } from "@/lib/api/hardening";
import { auditLog } from "@/lib/api/audit";
import { validateUploadedFile } from "@/lib/ipfs/uploadValidator";
import { pinata } from "@/lib/pinata";
import { createQuarantineRecord } from "@/lib/publishing/quarantine";
import { enqueueSideEffect } from "@/lib/backend/outbox";

// Identity-document submissions are the most sensitive upload surface in the
// app (they are reviewed by a human moderator), so submissions are limited to
// a handful per caller per hour rather than the generic per-minute default.
const SUBMISSION_RATE_LIMIT = { limit: 5, windowMs: 3_600_000 };

const VALID_DOCUMENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/jpg",
  "application/pdf",
];

const MAX_DOCUMENT_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * POST /api/verification/student
 * Submit student verification application with documents
 *
 * Hardening mirrors the material upload routes:
 *  - magic-number validation (validateUploadedFile) so a file whose bytes do
 *    not match its declared MIME type is rejected before it is stored or
 *    queued for moderator review;
 *  - per-account rate limiting via withApiHardening;
 *  - the document is pinned to IPFS and routed through the same quarantine /
 *    malware-scan pipeline as every other uploaded file, and the verification
 *    record references the pinned content hash instead of holding the raw
 *    buffer in MongoDB.
 */
export async function POST(request) {
  return withApiHardening(
    request,
    { route: "verification/student", rateLimit: SUBMISSION_RATE_LIMIT },
    async () => {
      try {
        // Authenticate user
        const authResult = await validateAuth(request);
        if (!authResult.valid) {
          auditLog({
            event: "verification_submit_rejected",
            route: "verification/student",
            method: "POST",
            status: 401,
            reason: "unauthenticated",
          });
          return NextResponse.json(
            { error: "Authentication required" },
            { status: 401 },
          );
        }

        const { address } = authResult;
        const walletAddressLower = address.toLowerCase();
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
          auditLog({
            event: "verification_submit_rejected",
            route: "verification/student",
            method: "POST",
            status: 400,
            reason: "missing_fields",
            walletAddress: walletAddressLower,
          });
          return NextResponse.json(
            { error: "All fields are required" },
            { status: 400 },
          );
        }

        // Verify wallet address matches authenticated user
        if (walletAddress.toLowerCase() !== walletAddressLower) {
          auditLog({
            event: "verification_submit_rejected",
            route: "verification/student",
            method: "POST",
            status: 403,
            reason: "wallet_address_mismatch",
            walletAddress: walletAddressLower,
          });
          return NextResponse.json(
            { error: "Wallet address mismatch" },
            { status: 403 },
          );
        }

        // Validate file size (5MB max)
        if (document.size > MAX_DOCUMENT_SIZE_BYTES) {
          auditLog({
            event: "verification_submit_rejected",
            route: "verification/student",
            method: "POST",
            status: 400,
            reason: "file_too_large",
            walletAddress: walletAddressLower,
          });
          return NextResponse.json(
            { error: "File size exceeds 5MB limit" },
            { status: 400 },
          );
        }

        // Validate declared file type against the allowlist
        if (!VALID_DOCUMENT_TYPES.includes(document.type)) {
          auditLog({
            event: "verification_submit_rejected",
            route: "verification/student",
            method: "POST",
            status: 400,
            reason: "invalid_file_type",
            walletAddress: walletAddressLower,
          });
          return NextResponse.json(
            { error: "Invalid file type. Only JPG, PNG, and PDF are allowed" },
            { status: 400 },
          );
        }

        // Magic-number validation: reject files whose actual bytes do not
        // match their declared MIME type (e.g. an executable renamed to .pdf)
        // before they are stored or queued for a human moderator to open.
        const fileCheck = await validateUploadedFile(
          document,
          VALID_DOCUMENT_TYPES,
        );
        if (!fileCheck.valid) {
          auditLog({
            event: "verification_submit_rejected",
            route: "verification/student",
            method: "POST",
            status: 400,
            reason: fileCheck.reason || "invalid_file_content",
            walletAddress: walletAddressLower,
          });
          return NextResponse.json(
            { error: fileCheck.reason || "Invalid file content" },
            { status: 400 },
          );
        }

        const { db } = await connectToDatabase();

        // Check for existing pending or approved verification
        const existingVerification = await db
          .collection("student_verifications")
          .findOne({
            walletAddress: walletAddressLower,
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

        // Pin the document and route it through the same quarantine /
        // malware-scan pipeline as every other uploaded file. The
        // verification record stores the pinned content hash (and gateway
        // URL for moderator review) rather than a raw buffer in MongoDB.
        const uploadedFile = await pinata.upload.public.file(document);
        const contentHash = uploadedFile.cid;
        const quarantine = await createQuarantineRecord({
          db,
          contentHash,
          fileName: document.name,
          mimeType: document.type,
          sizeBytes: document.size,
          uploaderAddress: walletAddressLower,
        });

        await enqueueSideEffect({
          sourceAggregate: "quarantine",
          sourceId: contentHash,
          intent: {
            type: "indexer",
            channel: "scan_content",
            payload: {
              contentHash,
              fileName: document.name,
              mimeType: document.type,
              sizeBytes: document.size,
              action: "scan",
            },
          },
        });

        const gatewayUrl = await pinata.gateways.public.convert(contentHash);

        // Create verification record
        const verification = {
          walletAddress: walletAddressLower,
          fullName,
          email: email.toLowerCase(),
          institution,
          studentId,
          expectedGraduation,
          document: {
            filename: document.name,
            mimetype: document.type,
            size: document.size,
            contentHash,
            gatewayUrl,
            quarantineState: quarantine.state,
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
          walletAddress: walletAddressLower,
          documentContentHash: contentHash,
          quarantineState: quarantine.state,
          submittedAt: new Date(),
          status: "pending",
          priority: "normal",
        });

        auditLog({
          event: "verification_submitted",
          route: "verification/student",
          method: "POST",
          status: 201,
          reason: "pending",
          walletAddress: walletAddressLower,
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
        auditLog({
          event: "verification_submit_failed",
          route: "verification/student",
          method: "POST",
          status: 500,
          reason: error?.message || String(error),
        });
        return NextResponse.json(
          { error: "Failed to submit verification", details: error.message },
          { status: 500 },
        );
      }
    },
  );
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
    const { db } = await connectToDatabase();

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
