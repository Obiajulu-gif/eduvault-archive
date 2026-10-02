export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { requirePermission } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { auditLog } from "@/lib/api/audit";
import { AppError, renderErrorResponse } from "@/lib/errors";
import {
  enqueueMaterialSearchProjection,
  enqueueMaterialSearchDeletion,
} from "@/lib/backend/materialSearchProjection";

function normalizeAddress(addr) {
  return String(addr || "").trim().toLowerCase();
}

export async function POST(request, context) {
  return withApiHardening(
    request,
    { route: "creator-material-archive" },
    async () => {
      const authorization = await requirePermission(request, "creator:manage");
      if (!authorization.ok) {
        auditLog({ event: "auth_failed", route: "creator/materials/[id]/archive", method: "POST", status: authorization.status });
        return renderErrorResponse(new AppError(authorization.status === 401 ? "AUTH_UNAUTHENTICATED" : "AUTH_FORBIDDEN", { details: { reason: authorization.status === 401 ? "Authentication required." : "Creator access required." } }), { instance: "/api/creator/materials/[id]/archive",
         });
      }
      const user = authorization.user;

      const { params } = context || {};
      const resolvedParams = params ? await params : {};
      const id = resolvedParams.id;

      if (!id) {
        return renderErrorResponse(new AppError("VALIDATION_FAILED", { details: { reason: "Missing material ID." } }), { instance: "/api/creator/materials/[id]/archive",
         });
      }

      try {
        const db = await getDb();
        const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
        const material = await db.collection("materials").findOne(query);

        if (!material) {
          return renderErrorResponse(new AppError("NOT_FOUND", { details: { reason: "Material not found." } }), { instance: `/api/creator/materials/${id}/archive`, });
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
          return renderErrorResponse(new AppError("AUTH_FORBIDDEN", { details: { reason: "Forbidden: only the material owner can archive or restore this resource." } }), { instance: `/api/creator/materials/${id}/archive`, });
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
          // Archived materials are not searchable; restored materials are indexable again.
          searchVisibility: archived ? "hidden" : "public",
        };

        await db.collection("materials").updateOne(query, { $set: updateDoc });
        const updatedMaterial = { ...material, ...updateDoc };

        if (archived) {
          // Remove the material from all search indexes so restricted records cannot
          // leak through unauthorized queries.
          await enqueueMaterialSearchDeletion({
            db,
            material: updatedMaterial,
            reason: "material_archived",
            now,
          });
        } else {
          await enqueueMaterialSearchProjection({
            db,
            material: updatedMaterial,
            reason: "material_restored",
            now,
          });
        }

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
        return renderErrorResponse(new AppError("INTERNAL", { details: { reason: "Failed to update material archive state." } }), { instance: `/api/creator/materials/${id}/archive`, });
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
