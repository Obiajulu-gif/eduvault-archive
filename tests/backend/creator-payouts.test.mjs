/**
 * Backend tests for GET /api/creator/payouts - Issue #419.
 *
 * Mirrors the aggregation logic of the route using in-memory collection
 * doubles so the tests stay fast and deterministic without a real MongoDB.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

const COMPLETED_PURCHASE_STATUSES = ["confirmed", "settled", "completed"];
const PENDING_PURCHASE_STATUSES = ["pending", "indexing"];
const REFUNDED_PURCHASE_STATUSES = ["refunded"];
const COMPLETED_PAYOUT_STATUSES = ["completed", "paid", "settled"];
const PENDING_PAYOUT_STATUSES = ["pending", "processing"];

class ValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

function validateDateRangeQuery(searchParams, { maxRangeDays = 366, defaultRangeDays = 30 } = {}) {
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");

  const to = toParam ? new Date(toParam) : new Date();
  if (Number.isNaN(to.getTime())) {
    throw new ValidationError("Invalid 'to' date", { field: "to" });
  }

  const from = fromParam
    ? new Date(fromParam)
    : new Date(to.getTime() - defaultRangeDays * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime())) {
    throw new ValidationError("Invalid 'from' date", { field: "from" });
  }

  if (from > to) {
    throw new ValidationError("'from' date must not be after 'to' date", { field: "from" });
  }

  const rangeDays = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
  if (rangeDays > maxRangeDays) {
    throw new ValidationError(`Date range cannot exceed ${maxRangeDays} days`, { field: "from" });
  }

  return { from, to };
}

function matchesQuery(doc, query = {}) {
  return Object.entries(query).every(([key, value]) => {
    if (value && typeof value === "object") {
      if ("$in" in value) return value.$in.includes(doc[key]);
      if ("$gte" in value && "$lte" in value) {
        return doc[key] >= value.$gte && doc[key] <= value.$lte;
      }
    }
    return doc[key] === value;
  });
}

function makeCursor(results) {
  return {
    toArray: async () => results,
    sort: () => makeCursor(results),
  };
}

function makeCollection(docs = []) {
  const store = [...docs];
  return {
    find(query = {}) {
      return makeCursor(store.filter((doc) => matchesQuery(doc, query)));
    },
    async aggregate(pipeline) {
      const matchStage = pipeline.find((stage) => stage.$match)?.$match ?? {};
      const matched = store.filter((doc) => matchesQuery(doc, matchStage));
      const groupStage = pipeline.find((stage) => stage.$group)?.$group;
      if (!groupStage) return makeCursor(matched);

      const groups = new Map();
      for (const doc of matched) {
        const key = groupStage._id === null ? null : doc[String(groupStage._id).replace("$", "")];
        const existing = groups.get(key) ?? { _id: key };
        for (const [field, expression] of Object.entries(groupStage)) {
          if (field === "_id") continue;
          if (expression.$sum) {
            const value =
              typeof expression.$sum === "number"
                ? expression.$sum
                : Number(doc[String(expression.$sum.$toDouble ?? expression.$sum).replace("$", "")]) || 0;
            existing[field] = (existing[field] ?? 0) + value;
          }
        }
        groups.set(key, existing);
      }

      let out = [...groups.values()];
      const sortStage = pipeline.find((stage) => stage.$sort)?.$sort;
      if (sortStage) {
        const [[field, dir]] = Object.entries(sortStage);
        out = out.sort((a, b) => (a[field] - b[field]) * dir);
      }
      return makeCursor(out);
    },
  };
}

function makeDb(collections = {}) {
  return { collection: (name) => collections[name] ?? makeCollection() };
}

function buildMaterialKeys(material) {
  return [material?._id, material?.materialId].filter(Boolean).map((value) => String(value));
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

async function sumPurchases(purchases, materialIdStrings, statuses, dateRange) {
  const match = { materialId: { $in: materialIdStrings }, status: { $in: statuses } };
  if (dateRange) match.purchasedAt = { $gte: dateRange.from, $lte: dateRange.to };
  const agg = await (
    await purchases.aggregate([
      { $match: match },
      { $group: { _id: null, total: { $sum: { $toDouble: "$amount" } }, count: { $sum: 1 } } },
    ])
  ).toArray();
  return { total: agg[0]?.total ?? 0, count: agg[0]?.count ?? 0 };
}

async function getPayoutReport(creatorAddress, db, searchParams = new URLSearchParams()) {
  const { from, to } = validateDateRangeQuery(searchParams);

  const materials = db.collection("materials");
  const purchases = db.collection("purchases");
  const payouts = db.collection("payouts");

  const creatorMaterials = await (await materials.find({ userAddress: creatorAddress })).toArray();
  const materialTitleMap = new Map();
  for (const material of creatorMaterials) {
    const title = material.title || "Untitled material";
    for (const key of buildMaterialKeys(material)) materialTitleMap.set(key, title);
  }
  const materialIdStrings = [...materialTitleMap.keys()];

  if (materialIdStrings.length === 0) {
    return {
      creatorAddress,
      earnings: { grossRevenue: 0, salesCount: 0 },
      payouts: { totalPaidOut: 0, totalPending: 0, lastPayoutAt: null },
      outstandingBalance: 0,
      byMaterial: [],
    };
  }

  const [grossAllTime, pendingAllTime, refundedAllTime, windowGross, payoutDocs, topMaterialsAgg] =
    await Promise.all([
      sumPurchases(purchases, materialIdStrings, COMPLETED_PURCHASE_STATUSES),
      sumPurchases(purchases, materialIdStrings, PENDING_PURCHASE_STATUSES),
      sumPurchases(purchases, materialIdStrings, REFUNDED_PURCHASE_STATUSES),
      sumPurchases(purchases, materialIdStrings, COMPLETED_PURCHASE_STATUSES, { from, to }),
      (await payouts.find({ creatorAddress })).toArray(),
      (
        await purchases.aggregate([
          { $match: { materialId: { $in: materialIdStrings }, status: { $in: COMPLETED_PURCHASE_STATUSES } } },
          { $group: { _id: "$materialId", sales: { $sum: 1 }, revenue: { $sum: { $toDouble: "$amount" } } } },
          { $sort: { revenue: -1 } },
        ])
      ).toArray(),
    ]);

  const totalPaidOut = payoutDocs
    .filter((p) => COMPLETED_PAYOUT_STATUSES.includes(p.status))
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const totalPending = payoutDocs
    .filter((p) => PENDING_PAYOUT_STATUSES.includes(p.status))
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

  const byMaterial = topMaterialsAgg.map((entry) => ({
    materialId: String(entry._id),
    title: materialTitleMap.get(String(entry._id)) || "Untitled material",
    salesCount: entry.sales,
    grossRevenue: round2(entry.revenue),
  }));

  return {
    creatorAddress,
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
    payouts: { totalPaidOut: round2(totalPaidOut), totalPending: round2(totalPending) },
    outstandingBalance: round2(Math.max(grossAllTime.total - totalPaidOut, 0)),
    byMaterial,
  };
}

describe("Creator payout accounting - Issue #419", () => {
  test("returns zeroed report for a creator with no materials", async () => {
    const db = makeDb({ materials: makeCollection([]), purchases: makeCollection([]), payouts: makeCollection([]) });
    const result = await getPayoutReport("GCREATOR_EMPTY", db);
    assert.equal(result.earnings.grossRevenue, 0);
    assert.equal(result.outstandingBalance, 0);
    assert.deepEqual(result.byMaterial, []);
  });

  test("aggregates gross revenue from completed sales only", async () => {
    const db = makeDb({
      materials: makeCollection([{ _id: "mat-1", userAddress: "GCREATOR_1", title: "Intro to Stellar" }]),
      purchases: makeCollection([
        { materialId: "mat-1", status: "confirmed", amount: "10", purchasedAt: new Date() },
        { materialId: "mat-1", status: "settled", amount: "15", purchasedAt: new Date() },
        { materialId: "mat-1", status: "pending", amount: "99", purchasedAt: new Date() },
      ]),
      payouts: makeCollection([]),
    });
    const result = await getPayoutReport("GCREATOR_1", db);
    assert.equal(result.earnings.grossRevenue, 25);
    assert.equal(result.earnings.salesCount, 2);
    assert.equal(result.earnings.pendingRevenue, 99);
    assert.equal(result.earnings.pendingCount, 1);
  });

  test("excludes refunded purchases from gross revenue and tracks them separately", async () => {
    const db = makeDb({
      materials: makeCollection([{ _id: "mat-r", userAddress: "GCREATOR_R", title: "Refund Case" }]),
      purchases: makeCollection([
        { materialId: "mat-r", status: "confirmed", amount: "20", purchasedAt: new Date() },
        { materialId: "mat-r", status: "refunded", amount: "20", purchasedAt: new Date() },
      ]),
      payouts: makeCollection([]),
    });
    const result = await getPayoutReport("GCREATOR_R", db);
    assert.equal(result.earnings.grossRevenue, 20);
    assert.equal(result.earnings.refundedAmount, 20);
    assert.equal(result.earnings.refundedCount, 1);
  });

  test("computes outstanding balance as gross revenue minus completed payouts", async () => {
    const db = makeDb({
      materials: makeCollection([{ _id: "mat-2", userAddress: "GCREATOR_2", title: "DeFi 101" }]),
      purchases: makeCollection([
        { materialId: "mat-2", status: "confirmed", amount: "50", purchasedAt: new Date() },
      ]),
      payouts: makeCollection([
        { creatorAddress: "GCREATOR_2", status: "completed", amount: "30", createdAt: new Date() },
        { creatorAddress: "GCREATOR_2", status: "pending", amount: "5", createdAt: new Date() },
      ]),
    });
    const result = await getPayoutReport("GCREATOR_2", db);
    assert.equal(result.payouts.totalPaidOut, 30);
    assert.equal(result.payouts.totalPending, 5);
    assert.equal(result.outstandingBalance, 20);
  });

  test("does not go negative when payouts exceed recorded revenue", async () => {
    const db = makeDb({
      materials: makeCollection([{ _id: "mat-3", userAddress: "GCREATOR_3", title: "Edge Case" }]),
      purchases: makeCollection([
        { materialId: "mat-3", status: "confirmed", amount: "10", purchasedAt: new Date() },
      ]),
      payouts: makeCollection([
        { creatorAddress: "GCREATOR_3", status: "completed", amount: "40", createdAt: new Date() },
      ]),
    });
    const result = await getPayoutReport("GCREATOR_3", db);
    assert.equal(result.outstandingBalance, 0);
  });

  test("breaks down revenue and sales per material, sorted by revenue", async () => {
    const db = makeDb({
      materials: makeCollection([
        { _id: "mat-a", userAddress: "GCREATOR_4", title: "Rust Basics" },
        { _id: "mat-b", userAddress: "GCREATOR_4", title: "Wasm Deep Dive" },
      ]),
      purchases: makeCollection([
        { materialId: "mat-a", status: "confirmed", amount: "20", purchasedAt: new Date() },
        { materialId: "mat-b", status: "confirmed", amount: "30", purchasedAt: new Date() },
        { materialId: "mat-b", status: "confirmed", amount: "30", purchasedAt: new Date() },
      ]),
      payouts: makeCollection([]),
    });
    const result = await getPayoutReport("GCREATOR_4", db);
    assert.equal(result.byMaterial.length, 2);
    assert.equal(result.byMaterial[0].materialId, "mat-b");
    assert.equal(result.byMaterial[0].grossRevenue, 60);
    assert.equal(result.byMaterial[0].salesCount, 2);
    assert.equal(result.byMaterial[1].materialId, "mat-a");
  });

  test("does not include another creator's materials or payouts", async () => {
    const db = makeDb({
      materials: makeCollection([
        { _id: "mat-own", userAddress: "GCREATOR_A", title: "Mine" },
        { _id: "mat-other", userAddress: "GCREATOR_B", title: "Not mine" },
      ]),
      purchases: makeCollection([
        { materialId: "mat-own", status: "confirmed", amount: "15", purchasedAt: new Date() },
        { materialId: "mat-other", status: "confirmed", amount: "99", purchasedAt: new Date() },
      ]),
      payouts: makeCollection([
        { creatorAddress: "GCREATOR_A", status: "completed", amount: "5", createdAt: new Date() },
        { creatorAddress: "GCREATOR_B", status: "completed", amount: "999", createdAt: new Date() },
      ]),
    });
    const result = await getPayoutReport("GCREATOR_A", db);
    assert.equal(result.earnings.grossRevenue, 15);
    assert.equal(result.payouts.totalPaidOut, 5);
  });

  test("rejects an invalid date range", async () => {
    const db = makeDb({ materials: makeCollection([]), purchases: makeCollection([]), payouts: makeCollection([]) });
    const params = new URLSearchParams({ from: "not-a-date" });
    await assert.rejects(() => getPayoutReport("GCREATOR_X", db, params), ValidationError);
  });

  test("rejects a 'from' date after the 'to' date", async () => {
    const db = makeDb({ materials: makeCollection([]), purchases: makeCollection([]), payouts: makeCollection([]) });
    const params = new URLSearchParams({ from: "2026-02-01", to: "2026-01-01" });
    await assert.rejects(() => getPayoutReport("GCREATOR_X", db, params), ValidationError);
  });
});
