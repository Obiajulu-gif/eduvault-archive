export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { getUserFromCookie } from "@/lib/api/auth";
import { auditLog } from "@/lib/api/audit";
import { appendAuditRecord } from "@/lib/backend/auditLedger";

async function getAdminUser(request) {
  const user = await getUserFromCookie(request);
  if (!user || user.role !== "admin") return null;
  return user;
}

export async function POST(request) {
  try {
    const admin = await getAdminUser(request);
    if (!admin) {
      return NextResponse.json(
        { error: "Unauthorized. Admin access required." },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { applicationId, action } = body;

    if (!applicationId || !["approve", "reject"].includes(action)) {
      return NextResponse.json(
        { error: "applicationId and valid action (approve/reject) are required" },
        { status: 400 }
      );
    }

    const db = await getDb();
    const applications = db.collection("verification_applications");
    const profiles = db.collection("profiles");

    const application = await applications.findOne({ _id: applicationId });
    if (!application) {
      return NextResponse.json(
        { error: "Application not found" },
        { status: 404 }
      );
    }

    if (application.status !== "pending") {
      return NextResponse.json(
        { error: `Application is already ${application.status}` },
        { status: 400 }
      );
    }

    const newStatus = action === "approve" ? "approved" : "rejected";
    const updateFields = {
      status: newStatus,
      reviewedBy: admin.sub || admin._id,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    };

    await applications.updateOne(
      { _id: applicationId },
      { $set: updateFields }
    );

    if (action === "approve") {
      await profiles.updateOne(
        { uuid: application.userUuid },
        {
          $set: {
            profileType: application.requestedType || "institution",
            verifiedAt: new Date(),
            updatedAt: new Date(),
          },
        }
      );
    }

    await appendAuditRecord({
      db,
      operationId: request.headers.get("x-idempotency-key") || `verification:${applicationId}:${action}`,
      actor: admin.sub || admin._id,
      action: `verification.${action}`,
      target: { type: "verification_application", id: String(applicationId) },
      intent: { action, applicationId },
      result: { status: newStatus },
    });

    auditLog({
      event: `admin_verification_${action}`,
      route: "admin/verification",
      method: "POST",
      status: 200,
      actor: admin.sub || admin._id,
      materialId: applicationId,
    });

    return NextResponse.json({ success: true, status: newStatus });
  } catch (error) {
    console.error("[admin/verification] POST error:", error);
    return NextResponse.json(
      { error: error.message || "Internal Server Error" },
      { status: 500 }
    );
  }
}

export async function GET(request) {
  try {
    const admin = await getAdminUser(request);
    if (!admin) {
      return NextResponse.json(
        { error: "Unauthorized. Admin access required." },
        { status: 403 }
      );
    }

    const db = await getDb();
    const applications = await db
      .collection("verification_applications")
      .find({ status: "pending" })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    return NextResponse.json({ applications });
  } catch (error) {
    console.error("[admin/verification] GET error:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
