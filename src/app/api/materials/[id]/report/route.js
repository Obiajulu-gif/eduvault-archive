export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { auditLog } from "@/lib/api/audit";
import { getUserFromCookie } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";

export const runtime = "nodejs";

function materialObjectId(id) {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

// POST /api/materials/[id]/report
export async function POST(request, { params }) {
  return withApiHardening(
    request,
    { route: "materials.report", rateLimit: { limit: 10, windowMs: 60_000 } },
    async () => {
      try {
        const materialId = params?.id;
        if (!materialId || !ObjectId.isValid(materialId)) {
          return NextResponse.json({ error: "Invalid material ID" }, { status: 400 });
        }

        const user = await getUserFromCookie(request);
        if (!user) {
          auditLog({ event: "auth_failed", route: "materials.report", method: "POST", status: 401 });
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await request.json();
        const reason = body?.reason;
        const description = body?.description || "";

        if (!reason) {
          return NextResponse.json({ error: "Reason is required to file a report" }, { status: 400 });
        }

        const db = await getDb();
        const material = await db.collection("materials").findOne({ _id: new ObjectId(materialId) });
        if (!material) {
          return NextResponse.json({ error: "Material not found" }, { status: 404 });
        }

        let reporterAddress = user.walletAddress || user.address || user.walletAddressLower || user.id || "";
        if (!reporterAddress && user.sub && ObjectId.isValid(user.sub)) {
          const dbUser = await db.collection("users").findOne({ _id: new ObjectId(user.sub) });
          reporterAddress = dbUser?.walletAddress || dbUser?.address || dbUser?.walletAddressLower || "";
        }

        const now = new Date();
        const reportDoc = {
          materialId,
          materialTitle: material.title,
          reason,
          description,
          reporterAddress,
          reporterId: user.sub || user.id || null,
          reporterName: user.name || "Anonymous",
          status: "pending_review",
          moderationStatus: "pending_review",
          createdAt: now,
          updatedAt: now,
        };

        const result = await db.collection("reports").insertOne(reportDoc);

        auditLog({
          event: "material_reported",
          route: "materials.report",
          method: "POST",
          status: 201,
          actor: user.sub,
          materialId,
        });

        return NextResponse.json({
          success: true,
          reportId: result.insertedId,
          message: "Your report has been successfully submitted and is under admin review.",
          moderation: {
            status: "pending_review",
            placeholder: "Admin review will process this flag shortly."
          }
        }, { status: 201 });
      } catch (err) {
        auditLog({
          event: "material_report_failed",
          route: "materials.report",
          method: "POST",
          status: 500,
          reason: err.message,
        });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
