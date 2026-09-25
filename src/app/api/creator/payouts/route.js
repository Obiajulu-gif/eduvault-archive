import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { getUserFromCookie } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { validateDateRangeQuery } from "@/lib/api/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const COMPLETED_PURCHASE_STATUSES = ["confirmed", "settled", "completed"];
const PENDING_PURCHASE_STATUSES = ["pending", "indexing"];
const REFUNDED_PURCHASE_STATUSES = ["refunded"];
const COMPLETED_PAYOUT_STATUSES = ["completed", "paid", "settled"];
const PENDING_PAYOUT_STATUSES = ["pending", "processing"];

function buildMaterialKeys(material) {
  return [material?._id, material?.materialId]
    .filter(Boolean)
    .map((value) => String(value));
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

async function sumPurchases(purchases, materialIdStrings, statuses, dateRange) {
  const match = {
    materialId: { $in: materialIdStrings },
    status: { $in: statuses },
  };
  if (dateRange) {
    match.purchasedAt = { $gte: dateRange.from, $lte: dateRange.to };
  }

  const agg = await purchases
    .aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          total: { $sum: { $toDouble: "$amount" } },
          count: { $sum: 1 },
        },
      },
    ])
    .toArray();

  return { total: agg[0]?.total ?? 0, count: agg[0]?.count ?? 0 };
}

function emptyReport(creatorAddress, from, to) {
  return {
    creatorAddress,
    dateRange: { from: from.toISOString(), to: to.toISOString() },
    earnings: {
      grossRevenue: 0,
      salesCount: 0,
      windowRevenue: 0,
      windowSalesCount: 0,
      pendingRevenue: 0,
      pendingCount: 0,
      refundedAmount: 0,
      refundedCount: 0,
    },
    payouts: { totalPaidOut: 0, totalPending: 0, lastPayoutAt: null },
    outstandingBalance: 0,
    byMaterial: [],
  };
}

export async function GET(request) {
  return withApiHardening(
    request,
    { route: "creator-payouts", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const creatorAddress = user.walletAddress || user.address || user.id;
      if (!creatorAddress) {
        return NextResponse.json({ error: "No wallet address on account" }, { status: 400 });
      }

      const url = new URL(request.url);
      const { from, to } = validateDateRangeQuery(url.searchParams);

      const db = await getDb();
      const materials = db.collection("materials");
      const purchases = db.collection("purchases");
      const payouts = db.collection("payouts");

      const creatorMaterials = await materials
        .find(
          { userAddress: creatorAddress },
          { projection: { _id: 1, materialId: 1, title: 1 } }
        )
        .toArray();

      const materialTitleMap = new Map();
      for (const material of creatorMaterials) {
        const title = material.title || "Untitled material";
        for (const key of buildMaterialKeys(material)) {
          materialTitleMap.set(key, title);
        }
      }
      const materialIdStrings = [...materialTitleMap.keys()];

      if (materialIdStrings.length === 0) {
        return NextResponse.json(emptyReport(creatorAddress, from, to));
      }

      const [grossAllTime, pendingAllTime, refundedAllTime, windowGross, payoutDocs, topMaterialsAgg] =
        await Promise.all([
          sumPurchases(purchases, materialIdStrings, COMPLETED_PURCHASE_STATUSES),
          sumPurchases(purchases, materialIdStrings, PENDING_PURCHASE_STATUSES),
          sumPurchases(purchases, materialIdStrings, REFUNDED_PURCHASE_STATUSES),
          sumPurchases(purchases, materialIdStrings, COMPLETED_PURCHASE_STATUSES, { from, to }),
          payouts.find({ creatorAddress }).sort({ createdAt: -1 }).toArray(),
          purchases
            .aggregate([
              {
                $match: {
                  materialId: { $in: materialIdStrings },
                  status: { $in: COMPLETED_PURCHASE_STATUSES },
                },
              },
              {
                $group: {
                  _id: "$materialId",
                  sales: { $sum: 1 },
                  revenue: { $sum: { $toDouble: "$amount" } },
                },
              },
              { $sort: { revenue: -1 } },
            ])
            .toArray(),
        ]);

      const totalPaidOut = payoutDocs
        .filter((p) => COMPLETED_PAYOUT_STATUSES.includes(p.status))
        .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
      const totalPending = payoutDocs
        .filter((p) => PENDING_PAYOUT_STATUSES.includes(p.status))
        .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
      const lastPayoutAt = payoutDocs[0]?.createdAt ?? null;

      const byMaterial = topMaterialsAgg.map((entry) => ({
        materialId: String(entry._id),
        title: materialTitleMap.get(String(entry._id)) || "Untitled material",
        salesCount: entry.sales,
        grossRevenue: round2(entry.revenue),
      }));

      return NextResponse.json({
        creatorAddress,
        dateRange: { from: from.toISOString(), to: to.toISOString() },
        earnings: {
          grossRevenue: round2(grossAllTime.total),
          salesCount: grossAllTime.count,
          windowRevenue: round2(windowGross.total),
          windowSalesCount: windowGross.count,
          pendingRevenue: round2(pendingAllTime.total),
          pendingCount: pendingAllTime.count,
          refundedAmount: round2(refundedAllTime.total),
          refundedCount: refundedAllTime.count,
        },
        payouts: {
          totalPaidOut: round2(totalPaidOut),
          totalPending: round2(totalPending),
          lastPayoutAt: lastPayoutAt ? new Date(lastPayoutAt).toISOString() : null,
        },
        outstandingBalance: round2(Math.max(grossAllTime.total - totalPaidOut, 0)),
        byMaterial,
      });
    }
  );
}
