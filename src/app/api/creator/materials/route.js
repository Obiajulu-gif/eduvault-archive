export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getUserFromCookie } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { auditLog } from "@/lib/api/audit";
import { errorResponse } from "@/lib/utils/errorResponse";

const PAGE_SIZE = 10;

function sanitizeMaterial(doc) {
  if (!doc) return doc;
  const { storageKey, fileUrl, metadataUrl, ...safe } = doc;
  return safe;
}

export async function GET(request) {
  return withApiHardening(
    request,
    { route: "creator-materials", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user) {
        auditLog({ event: "auth_failed", route: "creator/materials", method: "GET", status: 401 });
        return errorResponse({
          status: 401,
          detail: "Authentication required.",
          instance: "/api/creator/materials",
        });
      }

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
          ...(includeArchived ? {} : { archived: { $ne: true } }),
        };
        const [items, total] = await Promise.all([
          db.collection("materials").find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
          db.collection("materials").countDocuments(filter),
        ]);

        return NextResponse.json({
          materials: items.map(sanitizeMaterial),
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        });
      } catch (err) {
        auditLog({ event: "creator_materials_failed", route: "creator/materials", method: "GET", status: 500, reason: err.message });
        return errorResponse({
          status: 500,
          detail: "Failed to fetch creator materials.",
          instance: "/api/creator/materials",
        });
      }
    }
  );
}
