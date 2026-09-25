export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getUserFromCookie } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { auditLog } from "@/lib/api/audit";
import { errorResponse } from "@/lib/utils/errorResponse";
import { enqueueMaterialSearchProjection } from "@/lib/backend/materialSearchProjection";

function normalizeAddress(addr) {
  return String(addr || "").trim().toLowerCase();
}

export async function POST(request, context) {
  return withApiHardening(
    request,
    { route: "creator-material-archive" },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user) {
        auditLog({ event: "auth_failed", route: "creator/materials/[id]/archive", method: "POST", status: 401 });
        return errorResponse({
          status: 401,
          detail: "Authentication required.",
          instance: "/api/creator/materials/[id]/archive",
        });
      }

      const { params } = context || {};
      const resolvedParams = params ? await params : {};
      const id = resolvedParams.id;

      if (!id) {
        return errorResponse({
          status: 400,
          detail: "Missing material ID.",
          instance: "/api/creator/materials/[id]/archive",
        });
      }

      try {
        const db = await getDb();
        const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
        const material = await db.collection("materials").findOne(query);

        if (!material) {
          return errorResponse({
            status: 404,
            detail: "Material not found.",
            instance: `/api/creator/materials/${id}/archive`,
          });
        }

        const userAddress = user.walletAddress || user.address || user.sub || user.id;
        const ownerAddress = material.userAddress || material.ownerAddress || material.creatorAddress;

        if (
          !ownerAddress ||
          normalizeAddress(ownerAddress) !== normalizeAddress(userAddress)
        ) {
          auditLog({
            event: "material_archive_forbidden",
            route: "creator/materials/[id]/archive",
            method: "POST",
            status: 403,
            actor: user.sub || userAddress,
            materialId: id,
          });
          return errorResponse({
            status: 403,
            detail: "Forbidden: only the material owner can archive or restore this resource.",
            instance: `/api/creator/materials/${id}/archive`,
          });
        }

        const body = await request.json().catch(() => ({}));
        // If archived is explicitly provided as false, un-archive (restore). Otherwise default to archive (true).
        const archived = body.archived !== undefined ? Boolean(body.archived) : body.action !== "restore";

        const now = new Date();
        const nextSearchVersion = Number(material.searchVersion || material.version || 1) + 1;
        const updateDoc = {
          archived,
          archivedAt: archived ? now : null,
          updatedAt: now,
          updatedBy: userAddress,
          searchVersion: nextSearchVersion,
        };

        await db.collection("materials").updateOne(query, { $set: updateDoc });
        const updatedMaterial = { ...material, ...updateDoc };
        await enqueueMaterialSearchProjection({
          db,
          material: updatedMaterial,
          reason: archived ? "material_archived" : "material_restored",
          now,
        });

        auditLog({
          event: archived ? "material_archived" : "material_restored",
          route: "creator/materials/[id]/archive",
          method: "POST",
          status: 200,
          actor: user.sub || userAddress,
          materialId: id,
        });

        return NextResponse.json({
          success: true,
          materialId: id,
          archived,
          archivedAt: updateDoc.archivedAt,
        });
      } catch (err) {
        auditLog({
          event: "material_archive_failed",
          route: "creator/materials/[id]/archive",
          method: "POST",
          status: 500,
          reason: err.message,
        });
        return errorResponse({
          status: 500,
          detail: "Failed to update material archive state.",
          instance: `/api/creator/materials/${id}/archive`,
        });
      }
    }
  );
}

export async function PUT(request, context) {
  return POST(request, context);
}

export async function PATCH(request, context) {
  return POST(request, context);
}
