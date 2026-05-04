export const dynamic = "force-dynamic";

import { getDb } from "@/lib/mongodb";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { verifyDashboardToken } from "@/lib/auth/session";
import { withApiHardening } from "@/lib/api/hardening";
import { auditLog } from "@/lib/api/audit";

async function getUserFromCookie(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const cookieMatch = cookieHeader.match(/auth_token=([^;]+)/);
  const token = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
  if (!token) return null;
  const verification = await verifyDashboardToken(token, process.env.JWT_SECRET);
  if (!verification.valid) return null;
  return verification.payload;
}

/**
 * GET /api/purchased-materials
 * Returns all materials the authenticated user has a confirmed on-chain entitlement for.
 * Each item includes the purchase record merged with the material metadata.
 */
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "purchased-materials", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user) {
        auditLog({ event: "auth_failed", route: "purchased-materials", method: "GET", status: 401 });
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const buyerAddress = user.walletAddress || user.address || user.id;
      if (!buyerAddress) {
        return NextResponse.json({ error: "No wallet address on account" }, { status: 400 });
      }

      const db = await getDb();

      // Fetch all confirmed purchases for this buyer
      const purchases = await db
        .collection("purchases")
        .find({ buyerAddress, status: "confirmed" })
        .sort({ purchasedAt: -1 })
        .toArray();

      if (purchases.length === 0) {
        return NextResponse.json([]);
      }

      // Resolve material IDs — guard against malformed entries
      const materialIds = purchases
        .map((p) => {
          try {
            return ObjectId.isValid(p.materialId) ? new ObjectId(p.materialId) : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      const materials = await db
        .collection("materials")
        .find({ _id: { $in: materialIds } })
        .toArray();

      const materialMap = Object.fromEntries(
        materials.map((m) => [m._id.toString(), m])
      );

      // Merge purchase record with material metadata; strip sensitive storage fields
      const result = purchases.map((purchase) => {
        const material = materialMap[purchase.materialId] || null;
        if (!material) {
          return {
            purchaseId: purchase._id,
            materialId: purchase.materialId,
            purchasedAt: purchase.purchasedAt,
            transactionHash: purchase.transactionHash,
            material: null,
          };
        }

        const { storageKey, fileUrl, metadataUrl, ...safeMaterial } = material;

        return {
          purchaseId: purchase._id,
          materialId: purchase.materialId,
          purchasedAt: purchase.purchasedAt,
          transactionHash: purchase.transactionHash,
          material: safeMaterial,
        };
      });

      auditLog({ event: "purchased_materials_listed", route: "purchased-materials", method: "GET", status: 200, actor: user.sub });
      return NextResponse.json(result);
    }
  );
}
