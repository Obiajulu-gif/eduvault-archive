export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { auditLog } from "@/lib/api/audit";
import { errorResponse } from "@/lib/utils/errorResponse";

const COMPLETED_PURCHASE_STATUSES = ["confirmed", "settled", "completed"];
const DEFAULT_LIMIT = 5;

/**
 * GET /api/creators/top
 *
 * Ranks creators with persisted profiles by completed sales revenue across
 * their published materials. Falls back to material count for creators
 * with no completed sales yet, so newly onboarded creators still surface.
 */
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "creators-top", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      try {
        const url = new URL(request.url);
        const limit = Math.min(20, Math.max(1, parseInt(url.searchParams.get("limit") || String(DEFAULT_LIMIT), 10)));

        const db = await getDb();
        const materials = db.collection("materials");
        const purchases = db.collection("purchases");
        const users = db.collection("users");

        const materialsByCreator = await materials
          .aggregate([
            { $match: { userAddress: { $ne: null } } },
            {
              $group: {
                _id: "$userAddress",
                materialIds: { $push: { $toString: "$_id" } },
                uploadCount: { $sum: 1 },
              },
            },
          ])
          .toArray();

        if (materialsByCreator.length === 0) {
          return NextResponse.json({ creators: [] });
        }

        const allMaterialIds = materialsByCreator.flatMap((c) => c.materialIds);

        const revenueByMaterial = await purchases
          .aggregate([
            {
              $match: {
                materialId: { $in: allMaterialIds },
                status: { $in: COMPLETED_PURCHASE_STATUSES },
              },
            },
            {
              $group: {
                _id: "$materialId",
                revenue: { $sum: { $toDouble: "$amount" } },
                sales: { $sum: 1 },
              },
            },
          ])
          .toArray();

        const revenueMap = new Map(revenueByMaterial.map((r) => [r._id, r]));

        const creatorAddresses = materialsByCreator.map((c) => c._id);
        const profiles = await users
          .find(
            { $or: [{ walletAddress: { $in: creatorAddresses } }, { walletAddressLower: { $in: creatorAddresses.map((a) => String(a).toLowerCase()) } }] },
            { projection: { fullName: true, walletAddress: true, walletAddressLower: true, avatarUrl: true } }
          )
          .toArray();

        const profileMap = new Map();
        for (const profile of profiles) {
          const key = String(profile.walletAddress || profile.walletAddressLower).toLowerCase();
          profileMap.set(key, profile);
        }

        const ranked = materialsByCreator
          .map((creator) => {
            const totals = creator.materialIds.reduce(
              (acc, id) => {
                const entry = revenueMap.get(id);
                return {
                  revenue: acc.revenue + (entry?.revenue ?? 0),
                  sales: acc.sales + (entry?.sales ?? 0),
                };
              },
              { revenue: 0, sales: 0 }
            );

            const profile = profileMap.get(String(creator._id).toLowerCase());

            return {
              walletAddress: creator._id,
              name: profile?.fullName || `Creator ${String(creator._id).slice(0, 6)}`,
              avatarUrl: profile?.avatarUrl || null,
              revenue: totals.revenue,
              sales: totals.sales,
              uploadCount: creator.uploadCount,
            };
          })
          .sort((a, b) => {
            if (b.revenue !== a.revenue) return b.revenue - a.revenue;
            if (b.sales !== a.sales) return b.sales - a.sales;
            return b.uploadCount - a.uploadCount;
          })
          .slice(0, limit)
          .map((creator, index) => ({
            ...creator,
            rank: index + 1,
            revenue: `$${creator.revenue.toFixed(2)}`,
          }));

        return NextResponse.json({ creators: ranked });
      } catch (err) {
        auditLog({ event: "creators_top_failed", route: "creators/top", method: "GET", status: 500, reason: err.message });
        return errorResponse({
          status: 500,
          detail: "Failed to fetch top creators.",
          instance: "/api/creators/top",
        });
      }
    }
  );
}
