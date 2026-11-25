export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { requirePermission } from "@/lib/api/auth";
import { auditLog } from "@/lib/api/audit";
import { appendAuditRecord } from "@/lib/backend/auditLedger";
import {
  revokeCreatorVerification,
  expireStaleCreatorVerifications,
  reinstateCreatorVerification,
} from "@/lib/verification/creatorVerification";

export async function POST(request) {
  try {
    const authorization = await requirePermission(request, "admin:verification:manage");
    if (!authorization.ok) {
      return NextResponse.json(
        { error: "Forbidden" },
        { status: authorization.status }
      );
    }
    const admin = authorization.user;

    const body = await request.json();
    const { applicationId, action, reason, target, durationDays } = body;

    const ALLOWED_ACTIONS = ["approve", "reject", "revoke", "expire_stale", "reinstate"];
    if (!action || !ALLOWED_ACTIONS.includes(action)) {
      return NextResponse.json(
        { error: `Valid action (${ALLOWED_ACTIONS.join("/")}) is required` },
        { status: 400 }
      );
    }

    const db = await getDb();

    // 1. Expiration sweep action
    if (action === "expire_stale") {
      const result = await expireStaleCreatorVerifications({ db, actor: admin });
      return NextResponse.json({ success: true, action: "expire_stale", ...result });
    }

    const targetId = applicationId || target;
    if (!targetId) {
      return NextResponse.json(
        { error: `applicationId or target is required for action '${action}'` },
        { status: 400 }
      );
    }

    // 2. Administrative revocation action
    if (action === "revoke") {
      if (!reason || typeof reason !== "string" || !reason.trim()) {
        return NextResponse.json(
          { error: "A valid reason is required to revoke creator verification" },
          { status: 400 }
        );
      }
      const report = await revokeCreatorVerification({
        db,
        target: targetId,
        reason,
        actor: admin,
        idempotencyKey: request.headers.get("x-idempotency-key"),
      });
      return NextResponse.json(report);
    }

    // 3. Reinstatement / recovery action
    if (action === "reinstate") {
      const report = await reinstateCreatorVerification({
        db,
        target: targetId,
        actor: admin,
        durationDays: Number(durationDays) || 365,
        idempotencyKey: request.headers.get("x-idempotency-key"),
      });
      return NextResponse.json(report);
    }

    // 4. Approval and rejection actions (preserve existing contract)
    const applications = db.collection("verification_applications");
    const profiles = db.collection("profiles");

    const application = await applications.findOne({ _id: targetId });
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
      { _id: targetId },
      { $set: updateFields }
    );

    if (action === "approve") {
      const expiresAt = new Date();
      expiresAt.setFullYear(expiresAt.getFullYear() + 1); // 1 year expiry

      await profiles.updateOne(
        { uuid: application.userUuid },
        {
          $set: {
            profileType: application.requestedType || "institution",
            credential: {
              issuer: admin.sub || admin._id,
              evidence: `urn:eduvault:verification:${targetId}`,
              expiresAt: expiresAt,
              status: "active",
            },
            updatedAt: new Date(),
          },
        }
      );
    }

    await appendAuditRecord({
      db,
      operationId: request.headers.get("x-idempotency-key") || `verification:${targetId}:${action}`,
      actor: admin.sub || admin._id,
      action: `verification.${action}`,
      target: { type: "verification_application", id: String(targetId) },
      intent: { action, applicationId: targetId },
      result: { status: newStatus },
    });

    auditLog({
      event: `admin_verification_${action}`,
      route: "admin/verification",
      method: "POST",
      status: 200,
      actor: admin.sub || admin._id,
      materialId: targetId,
    });

    return NextResponse.json({ success: true, status: newStatus });
  } catch (error) {
    console.error("[admin/verification] POST error:", error);
    return NextResponse.json(
      { error: error.message || "Internal Server Error" },
      { status: error.status || 500 }
    );
  }
}

export async function GET(request) {
  try {
    const authorization = await requirePermission(request, "admin:verification:read");
    if (!authorization.ok) {
      return NextResponse.json(
        { error: "Forbidden" },
        { status: authorization.status }
      );
    }

    const { searchParams } = new URL(request.url);
    const statusFilter = searchParams.get("status") || "pending";
    const filter = statusFilter === "all" ? {} : { status: statusFilter };

    const db = await getDb();
    const applications = await db
      .collection("verification_applications")
      .find(filter)
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
