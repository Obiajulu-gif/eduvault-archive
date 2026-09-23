import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { getUserFromCookie } from "@/lib/api/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const COMPLETED_PURCHASE_STATUSES = ["confirmed", "settled", "completed"];
const INCOMPLETE_PURCHASE_STATUSES = ["pending", "indexing"];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseDateRange(url) {
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  const to = toParam ? new Date(toParam) : new Date();
  const from = fromParam
    ? new Date(fromParam)
    : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    const fallbackTo = new Date();
    return {
      from: new Date(fallbackTo.getTime() - 30 * 24 * 60 * 60 * 1000),
      to: fallbackTo,
    };
  }

  return { from, to };
}

function formatCurrency(amount) {
  return `$${Number(amount ?? 0).toFixed(2)}`;
}

function formatDate(date) {
  if (!date) return "Unknown";
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getMaterialActivity(material) {
  return (
    Number(material.views ?? material.viewCount ?? 0) +
    Number(material.downloads ?? material.downloadCount ?? 0) +
    Number(material.reviewsCount ?? material.reviewCount ?? 0)
  );
}

function buildMaterialKeys(material) {
  return [material?._id, material?.materialId]
    .filter(Boolean)
    .map((value) => String(value));
}

function buildEmptyChart() {
  const start = new Date();
  start.setDate(start.getDate() - 6);
  start.setHours(0, 0, 0, 0);

  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(start);
    day.setDate(day.getDate() + i);
    return {
      day: DAY_LABELS[day.getDay()],
      revenue: 0,
      orders: 0,
      uploads: 0,
      interest: 0,
    };
  });
}

async function safeFindArray(collection, query, options) {
  try {
    return await collection.find(query, options).toArray();
  } catch {
    return [];
  }
}

export async function GET(request) {
  try {
    const user = await getUserFromCookie(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const creatorAddress = user.walletAddress || user.address || user.id;
    if (!creatorAddress) {
      return NextResponse.json({ error: "No wallet address on account" }, { status: 400 });
    }

    const url = new URL(request.url);
    const { from, to } = parseDateRange(url);

    const db = await getDb();
    const purchases = db.collection("purchases");
    const materials = db.collection("materials");

    const creatorMaterials = await materials
      .find(
        { userAddress: creatorAddress },
        {
          projection: {
            _id: 1,
            materialId: 1,
            title: 1,
            visibility: 1,
            price: 1,
            createdAt: 1,
            updatedAt: 1,
            views: 1,
            viewCount: 1,
            downloads: 1,
            downloadCount: 1,
            trustedViewCount: 1,
            filteredViewCount: 1,
            trustedDownloadCount: 1,
            filteredDownloadCount: 1,
            reviewsCount: 1,
            reviewCount: 1,
          },
        }
      )
      .toArray();

    const materialIdStrings = [...new Set(creatorMaterials.flatMap(buildMaterialKeys))];
    const materialTitleMap = new Map();

    for (const material of creatorMaterials) {
      const keys = buildMaterialKeys(material);
      const title = material.title || "Untitled material";
      for (const key of keys) {
        materialTitleMap.set(key, title);
      }
    }

    if (materialIdStrings.length === 0) {
      return NextResponse.json({
        totalRevenue: 0,
        totalSales: 0,
        monthlySales: 0,
        pendingCount: 0,
        indexingCount: 0,
        uploadCount: 0,
        publishedCount: 0,
        draftCount: 0,
        materialActivity: 0,
        learnerInterest: 0,
        savedCount: 0,
        completedOrders: 0,
        hasActivity: false,
        chartData: buildEmptyChart(),
        topMaterials: [],
        recentOrders: [],
        withdrawals: [],
        dateRange: {
          from: from.toISOString(),
          to: to.toISOString(),
        },
      });
    }

    const completedMatch = {
      materialId: { $in: materialIdStrings },
      status: { $in: COMPLETED_PURCHASE_STATUSES },
    };
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const [
      allTimeAgg,
      monthlySalesAgg,
      incompleteAgg,
      chartAgg,
      topMaterialsAgg,
      recentOrdersDocs,
      savedDocs,
    ] = await Promise.all([
      purchases
        .aggregate([
          { $match: completedMatch },
          {
            $group: {
              _id: null,
              total: { $sum: { $toDouble: "$amount" } },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray(),
      purchases
        .aggregate([
          {
            $match: {
              ...completedMatch,
              purchasedAt: { $gte: from, $lte: to },
            },
          },
          { $count: "count" },
        ])
        .toArray(),
      purchases
        .aggregate([
          {
            $match: {
              materialId: { $in: materialIdStrings },
              status: { $in: INCOMPLETE_PURCHASE_STATUSES },
            },
          },
          {
            $group: {
              _id: "$status",
              count: { $sum: 1 },
            },
          },
        ])
        .toArray(),
      purchases
        .aggregate([
          {
            $match: {
              ...completedMatch,
              purchasedAt: { $gte: sevenDaysAgo },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: { format: "%Y-%m-%d", date: "$purchasedAt" },
              },
              revenue: { $sum: { $toDouble: "$amount" } },
              orders: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
      purchases
        .aggregate([
          { $match: completedMatch },
          {
            $group: {
              _id: "$materialId",
              sales: { $sum: 1 },
              revenue: { $sum: { $toDouble: "$amount" } },
            },
          },
          { $sort: { sales: -1 } },
          { $limit: 10 },
        ])
        .toArray(),
      purchases
        .find(completedMatch)
        .sort({ purchasedAt: -1, createdAt: -1, updatedAt: -1 })
        .limit(5)
        .toArray(),
      safeFindArray(db.collection("saved_materials"), {
        materialId: { $in: materialIdStrings },
      }),
    ]);

    const totalRevenue = allTimeAgg[0]?.total ?? 0;
    const totalSales = allTimeAgg[0]?.count ?? 0;
    const monthlySales = monthlySalesAgg[0]?.count ?? 0;
    const pendingCount = incompleteAgg.find((g) => g._id === "pending")?.count ?? 0;
    const indexingCount = incompleteAgg.find((g) => g._id === "indexing")?.count ?? 0;
    const savedCount = savedDocs.length;
    const learnerInterest = savedCount + pendingCount + indexingCount;
    const materialActivity = creatorMaterials.reduce(
      (total, material) => total + getMaterialActivity(material),
      0
    );
    const publishedCount = creatorMaterials.filter((m) => m.visibility !== "private").length;
    const draftCount = creatorMaterials.length - publishedCount;

    const saveCounts = new Map();
    for (const doc of savedDocs) {
      const key = String(doc.materialId);
      saveCounts.set(key, (saveCounts.get(key) ?? 0) + 1);
    }

    const salesByMaterial = new Map();
    for (const material of topMaterialsAgg) {
      salesByMaterial.set(String(material._id), {
        sales: material.sales ?? 0,
        revenue: material.revenue ?? 0,
      });
    }

    const topMaterials = creatorMaterials
      .map((material) => {
        const keys = buildMaterialKeys(material);
        const key = keys[0];
        const totals = keys.reduce(
          (current, materialKey) => {
            const next = salesByMaterial.get(materialKey);
            return {
              sales: current.sales + (next?.sales ?? 0),
              revenue: current.revenue + (next?.revenue ?? 0),
            };
          },
          { sales: 0, revenue: 0 }
        );
        const saves = buildMaterialKeys(material).reduce(
          (total, materialKey) => total + (saveCounts.get(materialKey) ?? 0),
          0
        );
        const activity = getMaterialActivity(material);
        return {
          id: key,
          name: material.title || "Untitled material",
          sales: totals.sales,
          completedOrders: totals.sales,
          learnerInterest: saves,
          activity,
          revenue: formatCurrency(totals.revenue),
          visibility: material.visibility || "private",
          uploadedAt: material.createdAt || null,
          trustedViews: material.trustedViewCount || 0,
          filteredViews: material.filteredViewCount || 0,
          trustedDownloads: material.trustedDownloadCount || 0,
          filteredDownloads: material.filteredDownloadCount || 0,
        };
      })
      .sort((a, b) => {
        if (b.completedOrders !== a.completedOrders) return b.completedOrders - a.completedOrders;
        if (b.learnerInterest !== a.learnerInterest) return b.learnerInterest - a.learnerInterest;
        if (b.activity !== a.activity) return b.activity - a.activity;
        return new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0);
      })
      .slice(0, 5);

    const chartMap = Object.fromEntries(
      chartAgg.map((d) => [d._id, { revenue: d.revenue ?? 0, orders: d.orders ?? 0 }])
    );
    const uploadMap = new Map();
    const interestMap = new Map();

    for (const material of creatorMaterials) {
      const createdAt = new Date(material.createdAt || 0);
      if (!Number.isNaN(createdAt.getTime()) && createdAt >= sevenDaysAgo) {
        const key = createdAt.toISOString().slice(0, 10);
        uploadMap.set(key, (uploadMap.get(key) ?? 0) + 1);
      }
    }

    for (const saved of savedDocs) {
      const savedAt = new Date(saved.savedAt || 0);
      if (!Number.isNaN(savedAt.getTime()) && savedAt >= sevenDaysAgo) {
        const key = savedAt.toISOString().slice(0, 10);
        interestMap.set(key, (interestMap.get(key) ?? 0) + 1);
      }
    }

    const chartData = Array.from({ length: 7 }, (_, i) => {
      const day = new Date(sevenDaysAgo);
      day.setDate(day.getDate() + i);
      const key = day.toISOString().slice(0, 10);
      return {
        day: DAY_LABELS[day.getDay()],
        revenue: chartMap[key]?.revenue ?? 0,
        orders: chartMap[key]?.orders ?? 0,
        uploads: uploadMap.get(key) ?? 0,
        interest: interestMap.get(key) ?? 0,
      };
    });

    const recentOrders = recentOrdersDocs.map((order) => {
      const materialId = String(order.materialId);
      return {
        id: String(order._id || `${materialId}-${order.buyerAddress || "buyer"}`),
        material: materialTitleMap.get(materialId) || "Unknown material",
        buyer: order.buyerAddress || "Unknown buyer",
        amount: formatCurrency(order.amount),
        status: order.status || "completed",
        date: formatDate(order.purchasedAt || order.createdAt || order.updatedAt),
      };
    });

    let withdrawals = [];
    try {
      const payoutDocs = await db
        .collection("payouts")
        .find({ creatorAddress })
        .sort({ createdAt: -1 })
        .limit(5)
        .toArray();

      withdrawals = payoutDocs.map((p) => ({
        date: formatDate(p.createdAt),
        amount: formatCurrency(p.amount),
        status: p.status === "completed" ? "Success" : "Pending",
      }));
    } catch {
      withdrawals = [];
    }

    return NextResponse.json({
      totalRevenue,
      totalSales,
      monthlySales,
      pendingCount,
      indexingCount,
      uploadCount: creatorMaterials.length,
      publishedCount,
      draftCount,
      materialActivity,
      learnerInterest,
      savedCount,
      completedOrders: totalSales,
      hasActivity:
        creatorMaterials.length > 0 ||
        totalSales > 0 ||
        learnerInterest > 0 ||
        materialActivity > 0,
      chartData,
      topMaterials,
      recentOrders,
      withdrawals,
      analyticsMethodology: {
        dedupeWindowMs: 30 * 60 * 1000,
        trustedViews: creatorMaterials.reduce((sum, material) => sum + (material.trustedViewCount || 0), 0),
        filteredViews: creatorMaterials.reduce((sum, material) => sum + (material.filteredViewCount || 0), 0),
        trustedDownloads: creatorMaterials.reduce((sum, material) => sum + (material.trustedDownloadCount || 0), 0),
        filteredDownloads: creatorMaterials.reduce((sum, material) => sum + (material.filteredDownloadCount || 0), 0),
      },
      dateRange: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
    });
  } catch (error) {
    console.error("[analytics] GET error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
