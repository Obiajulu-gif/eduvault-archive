export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { auditLog } from "@/lib/api/audit";
import { AppError, renderErrorResponse } from "@/lib/errors";
import {
  indexMaterial,
  removeMaterialFromIndex,
  materialVisibility,
} from "@/lib/search/index";

const PAGE_SIZE = 10;

function sanitizeMaterial(doc) {
  if (!doc) return doc;
  const { storageKey, fileUrl, metadataUrl, ...safe } = doc;
  return safe;
}

function isVisibleTo(material, userAddress) {
  const visibility = materialVisibility(material);
  if (visibility === "public") return true;
  if (visibility === "private") {
    return material.userAddress === userAddress;
  }
  if (visibility === "restricted") {
    if (material.userAddress === userAdress) return true;
    const allowed = Array.isArray(material.allowedAddresses)
      ? material.allowedAddresses
      : [];
    return allowed.includes(userAddress);
  }
  return false;
}

export async function GET(request) {
  return withApiHardening(
    request,
    { route: "creator-materials", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      const authorization = await requirePermission(request, "creator:manage");
      if (!authorization.ok) {
        auditLog({ event: "auth_failed", route: "creator/materials", method: "GET", status: authorization.status });
        return renderErrorResponse(new AppError(authorization.status === 401 ? "AUTH_UNAUTHENTICATED" : "AUTH_FORBIDDEN", { details: { reason: authorization.status === 401 ? "Authentication required." : "Creator access required." } }), { instance: "/api/creator/materials",
         });
      }
      const user = authorization.user;

      const url = new URL(request.url);
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || String(PAGE_SIZE), 10)));
      const skip = (page - 1) * limit;

      try {
        const db = await getDb();
        const userAddress = user.walletAddress || user.address || user.id;
        const includeArchived = url.searchParams.get("includeArchived") === "true";

        const filter = {
          userAddress,
          ...(includeArchived ? {} : {}),
        };
        const [items, total] = await Promise.all([
          db.collection("materials").find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
          db.collection("materials").countDocuments(filter),
        ]);

        const visibleItems = items.filter((item) => isVisibleTo(item, userAddress));

        return NextResponse.json({
          materials: visibleItems.map(sanitizeMaterial),
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        });
      } catch (err) {
        auditLog({ event: "creator_materials_failed", route: "creator/materials", method: "GET", status: 500, reason: err.message });
        return renderErrorResponse(new AppError("INTERNAL", { details: { reason: "Failed to fetch creator materials." } }), { instance: "/api/creator/materials",
         });
      }
    }
  );
}

export async function PATCH(request) {
  return withApiHardening(
    request,
    { route: "creator-materials", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user) {
        auditLog({ event: "auth_failed", route: "creator/materials", method: "PATCH", status: 401 });
        return renderErrorResponse(new AppError("AUTH_UNAUTHENTICATED", { details: { reason: "Authentication required." } }), { instance: "/api/creator/materials",
         });
      }

      try {
        const body = await request.json();
        const id = body?.id;
        if (!id) {
          return renderErrorResponse(new AppError("VALIDATION_FAILED", { details: { reason: "Material id is required." } }), { instance: "/api/creator/materials",
           });
        }

        const db = await getDb();
        const userAddress = user.walletAddress || user.address || user.id;
        const existing = await db.collection("materials").findOne({ _id: id });
        if (!existing) {
          return renderErrorResponse(new AppError("NOT_FOUND", { details: { reason: "Material not found." } }), { instance: "/api/creator/materials",
           });
        }
        if (existing.userAddress !== userAddress) {
          auditLog({ event: "creator_materials_forbidden", route: "creator/materials", method: "PATCH", status: 403 });
          return renderErrorResponse(new AppError("AUTH_FORBIDDEN", { details: { reason: "Not authorized to modify this material." } }), { instance: "/api/creator/materials",
           });
        }

        const update = { updatedAt: new Date() };
        const visibilityChanged =
          typeof body.visibility !== "undefined" &&
          body.visibility !== materialVisibility(existing);
        if (typeof body.visibility !== "undefined") update.visibility = body.visibility;
        if (typeof body.allowedAddresses !== "undefined") update.allowedAddresses = body.allowedAddresses;
        if (typeof body.archived !== "undefined") update.archived = body.archived;

        const result = await db.collection("materials").findOneAndUpdate(
          { _id: id },
          { $set: update },
          { returnDocument: "after" }
        );

        const updated = result.value || result;
        if (updated) {
          if (updated.archived === true) {
            await removeMaterialFromIndex(db, updated);
          } else {
            await indexMaterial(db, updated);
          }
        }

        auditLog({
          event: "creator_material_updated",
          route: "creator/materials",
          method: "PATCH",
          status: 200,
          visibilityChanged,
        });

        return NextResponse.json({ material: sanitizeMaterial(updated) });
      } catch (err) {
        auditLog({ event: "creator_materials_patch_failed", route: "creator/materials", method: "PATCH", status: 500, reason: err.message });
        return renderErrorResponse(new AppError("INTERNAL", { details: { reason: "Failed to update material." } }), { instance: "/api/creator/materials",
         });
      }
    }
  );
}

export async function DELETE(request) {
  return withApiHardening(
    request,
    { route: "creator-materials", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user) {
        auditLog({ event: "auth_failed", route: "creator/materials", method: "DELETE", status: 401 });
        return renderErrorResponse(new AppError("AUTH_UNAUTHENTICATED", { details: { reason: "Authentication required." } }), { instance: "/api/creator/materials",
         });
      }

      const url = new URL(request.url);
      const id = url.searchParams.get("id");
      if (!id) {
        return renderErrorResponse(new AppError("VALIDATION_FAILED", { details: { reason: "Material id is required." } }), { instance: "/api/creator/materials",
         });
      }

      try {
        const db = await getDb();
        const userAddress = user.walletAddress || user.address || user.id;
        const existing = await db.collection("materials").findOne({ _id: id });
        if (!existing) {
          return renderErrorResponse(new AppError("NOT_FOUND", { details: { reason: "Material not found." } }), { instance: "/api/creator/materials",
           });
        }
        if (existing.userAddress !== userAddress) {
          auditLog({ event: "creator_materials_forbidden", route: "creator/materials", method: "DELETE", status: 403 });
          return renderErrorResponse(new AppError("AUTH_FORBIDDEN", { details: { reason: "Not authorized to delete this material." } }), { instance: "/api/creator/materials",
           });
        }

        await db.collection("materials").deleteOne({ _id: id });
        await removeMaterialFromIndex(db, existing);

        auditLog({
          event: "creator_material_deleted",
          route: "creator/materials",
          method: "DELETE",
          status: 200,
        });

        return NextResponse.json({ deleted: true, id });
      } catch (err) {
        auditLog({ event: "creator_materials_delete_failed", route: "creator/materials", method: "DELETE", status: 500, reason: err.message });
        return renderErrorResponse(new AppError("INTERNAL", { details: { reason: "Failed to delete material." } }), { instance: "/api/creator/materials",
         });
      }
    }
  );
}
