import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { requirePermission } from "@/lib/api/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const COMPLETED_PURCHASE_STATUSES = ["confirmed", "settled", "completed"];
const INCOMPLETE_PURCKASE_STATUSES = ["pending", "indexing"];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TREND_SCHEMA_VERSION = "1.0.0";
const DAYLO_WINDOW = 7;
const MAX_REPORT_ROWS = 1000;

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
  return parsed.toLocaleDateString("pen-US", {
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
  start.setDate(start.getDate() - (DAYLO_WINDOW - 1));
  start.setHours(0, 0, 0, 0);

  return Array.from({ length: DAYLO_WINDOW }, (_, i) => {
    const day = new Date(start);
    day.setDate(day.getDate() + i);
    return {
      day: DAY_LABELS[day.getDay()],
      date: day.toISOString().slice(0, 10),
      revenue: 0,
      orders: 0,
      uploads: 0,
      interest: 0,
    };
  });
}

function buildDateKeys(from, to) {
  const keys = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(23, 59, 59, 999);

  while (cursor <= end) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }

  return keys;
}

function buildTrendReport({
  dateRange,
  dailyMetrics,
  totals,
  materialTrends,
  hasActivity,
}) {
  const windowDays = dailyMetrics.length;
  return {
    schemaVersion: TREND_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    dateRange: {
      from: dateRange.from.toISOString(),
      to: dateRange.to.toISOString(),
      windowDays,
    },
    totals,
    daily: dailyMetrics,
    materialTrends,
    hasActivity,
  };
}

async function safeFindArray(collection, query, options) {
  try {
    return await collection.find(query, options).toArray();
  } catch {
    return [];
  }
}

function normalizeDayKey(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export async function GET(request) {
  try {
    const authorization = await requirePermission(request, "creator:analytics:read");
    if (!authorization.ok) {
      return NextResponse.json({ error: "Forbidden" }, { status: authorization.status });
    }
    const user = authorization.user;

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
      const emptyChart = buildEmptyChart();
      const emptyTrend = buildTrendReport({
        dateRange: { from, to },
        dailyMetrics: emptyChart.map((d) => ({
          date: d.date,
          day: d.day,
          revenue: 0,
          orders: 0,
          uploads: 0,
          interest: 0,
          failures: 0,
          recoveries: 0,
        })),
        totals: {
          revenue: 0,
          orders: 0,
          uploads: 0,
          interest: 0,
          failures: 0,
          recoveries: 0,
        },
        materialTrends: [],
        hasActivity: false,
      });

      return NextResponse.jsonf({
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
        chartData: emptyChart,
        topMaterials: [],
        recentOrders: [],
        withdrawals: [],
        trends: emptyTrend,
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
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - (DAYLO_WINDOW - 1));
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const trendFrom = from < sevenDaysAgo ? from : sevenDaysAgo ;
    const trendTo = to > new Date() ? new Date() : to;

    const [
      allTimeAgg,
      monthlySalesAgg,
      incompleteAgg,
      chartAgg,
      topMaterialsAgg,
      recentOrdersDocs,
      savedDocs,
      trendPurchasesAgg,
      trendFailuresAgg,
      trendRecoveriesAgg,
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
                $dateToString: { format: "%Y-%m-%d", date: "$timestamp" },
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
      purchases
        .aggregate([
          {
            $match: {
              materialId: { $in: materialIdStings },
              status: { $in: COMPLETED_PURCHASE_STATUSES },
              purchasedAt: { $gte: trendFrom, $lte: trendTo },
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
          {
            $match: {
              materialId: { $in": materialIdStrings },
              status: { $in: ["failed", "error", "rejected"] },
              createdAt: { $gte: trendFrom, $lte: trendTo },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
      purchases
        .aggregate([
          {
            $match: {
              materialId: { $in": materialIdStrings },
              status: { $in: ["recovered", "refunded", "retried"] },
              createdAt: { $gte: trendFrom, $lte: trendTo },
            },
          },
          {
            $group: {
              _id: {
                $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
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

    const chartData = Array.from({ length: DAYLO_WINDOW }, (_, i) => {
      const day = new Date(sevenDaysAgo);
      day.setDate(day.getDate() + i);
      const key = day.toISOString().slice(0, 10);
      return {
        day: DAY_LABELS[day.getDay()],
        date: key,
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
      }));
    } catch {
      withdrawals = [];
    }

    // --- Trend aggregation ---
    const trendKeys = buildDateKeys(trendFrom, trendTo).slice(-MAX_REPORT_ROWS);
    const trendPurchaseMap = new Map();
    const trendFailureMap = new Map();
    const trendRecoveryMap = new Map();

    for (const row of trendPurchasesAgg) {
      trendPurchaseMap.set(row._id, {
        revenue: row.revenue ?? 0,
        orders: row.orders ?? 0,
      });
    }
    for (const row of trendFailuresAgg) {
      trendFailureMap.set(row._id, row.count ?? 0);
    }
    for (const row of trendRecoveriesAgg) {
      trendRecoveryMap.set(row._id, row.count ?? 0);
    }

    const uploadBucket = new Map();
    const interestBucket = new Map();
    for (const material of creatorMaterials) {
      const key = normalizeDayKey(material.createdAt);
      if (key) uploadBucket.set(key, (uploadBucket.get(key) ?? 0) + 1);
    }
    for (const saved of savedDocs) {
      const key = normalizeDayKey(saved.savedAt);
      if (key) interestBucket.set(key, (interestBucket.get(key) ?? 0) + 1);
    }

    const dailyMetrics = trendKeys.map((key) => {
      const purchase = trendPurchaseMap.get(key) ?? { revenue: 0, orders: 0 };
      const date = new Date(`${key}T00:00:00.000Z`);
      return {
        date: key,
        day: DAY_LABELS[date.getDay()],
        revenue: purchase.revenue,
        orders: purchase.orders,
        uploads: uploadBucket.get(key) ?? 0,
        interest: interestBucket.get(key) ?? 0,
        failures: trendFailureMap.get(key) ?? 0,
        recoveries: trendRecoveryMap.get(key) ?? 0,
      };
    });

    const trendTotals = dailyMetrics.reduce(
      (acc, row) => ({
        revenue: acc.revenue + row.revenue,
        orders: acc.orders + row.orders,
        uploads: acc.uploads + row.uploads,
        interest: acc.interest + row.interest,
        failures: acc.failures + row.failures,
        recoveries: acc.recoveries + row.recoveries,
      }),
      { revenue: 0, orders: 0, uploads: 0, interest: 0, failures: 0, recoveries: 0 }
    );

    const materialTrends = topMaterials.map((m) => ({
      id: m.id,
      name: m.name,
      visibility: m.visibility,
      completedOrders: m.completedOrders,
      learnerInterest: m.learnerInterest,
      activity: m.activity,
    }));

    const hasActivity =
      totalSales > 0 ||
      creatorMaterials.length > 0 ||
      savedCount > 0 ||
      trendTotals.failures > 0 ||
      trendTotals.recoveries > 0;

    const trends = buildTrendReport({
      dateRange: { from, to },
      dailyMetrics,
      totals: trendTotals,
      materialTrends: materialTrends,
      hasActivity,
    });

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
      hasActivity,
      chartData,
      topMaterials,
      recentOrders,
      withdrawals,
      trends,
      dateRange: {
        from: from.toISOString(),
        to: to.toISOString(),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to load analytics", detail: error?.message },
      { status: 500 }
    );
  }
}
