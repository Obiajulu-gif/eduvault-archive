import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { getUserFromCookie } from "@/lib/api/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCHEMA_VERSION = "1.0.0";
const DAY_MS = 24 * 60 * 60 * 1000;

const VALID_WINDOWS = new Set(["day", "week", "month"]);

function normalizeDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function truncateToWindow(date, window) {
  const d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (window === "day") {
    return d;
  }
  if (window === "week") {
    // Monday-aligned UTC week bucket.
    const day = d.getUTCDay();
    const diff = (day + 6) % 7;
    d.setUTCDate(d.getUTCDate() - diff);
    return d;
  }
  // month
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function addWindow(date, window) {
  const next = new Date(date.getTime());
  if (window === "day") {
    next.setUTCDate(next.getUTCDate() + 1);
  } else if (window === "week") {
    next.setUTCDate(next.getUTCDate() + 7);
  } else {
    next.setUTCMonth(next.getUTCMonth() + 1);
  }
  return next;
}

function formatBucketKey(date, window) {
  const iso = date.toISOString();
  return window === "month" ? iso.slice(0, 7) : iso.slice(0, 10);
}

function createEmptyBucket(date, window) {
  return {
    bucket: formatBucketKey(date, window),
    windowStart: date.toISOString(),
    windowEnd: addWindow(date, window).toISOString(),
    usageCount: 0,
    failureCount: 0,
    recoveryCount: 0,
    domainActivityCount: 0,
    grossVolume: 0,
    netVolume: 0,
  };
}

function classifyRecord(record) {
  const type = String(record.type || "").toLowerCase();
  const status = String(record.status || "").toLowerCase();
  const isFailure = status === "failed" || status === "error" || type === "failure";
  const isRecovery = type === "recovery" || type === "restore" || type === "repair";
  const isDomainActivity = type === "marketplace" || type === "domain" || type === "learning";
  const isUsage = type === "usage" || type === "purchase" || type === "storage";
  return { isFailure, isRecovery, isDomainActivity, isUsage };
}

function accumulate(bucket, record) {
  const { isFailure, isRecovery, isDomainActivity, isUsage } = classifyRecord(record);
  if (isFailure) bucket.failureCount += 1;
  if (isRecovery) bucket.recoveryCount += 1;
  if (isDomainActivity) bucket.domainActivityCount += 1;
  if (isUsage) bucket.usageCount += 1;
  const amount = Number(record.amount || 0);
  if (Number.isFinite(amount)) {
    bucket.grossVolume += amount;
    bucket.netVolume += amount;
  }
}

function buildTrends(records, window) {
  const buckets = new Map();
  for (const record of records) {
    const date = normalizeDate(record.date);
    if (!date) continue;
    const start = truncateToWindow(date, window);
    const key = formatBucketKey(start, window);
    if (!buckets.has(key)) buckets.set(key, createEmptyBucket(start, window));
    accumulate(buckets.get(key), record);
  }
  return Array.from(buckets.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));
}

function csvEscape(value) {
  const str = value == null ? "" : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(trends) {
  const headers = [
    "bucket",
    "windowStart",
    "windowEnd",
    "usageCount",
    "failureCount",
    "recoveryCount",
    "domainActivityCount",
    "grossVolume",
    "netVolume",
  ];
  const lines = [headers.join(",")];
  for (const t of trends) {
    lines.push(
      [
        t.bucket,
        t.windowStart,
        t.windowEnd,
        t.usageCount,
        t.failureCount,
        t.recoveryCount,
        t.domainActivityCount,
        t.grossVolume,
        t.netVolume,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\n");
}

function parseRange(searchParams) {
  const from = normalizeDate(searchParams.get("from"));
  const to = normalizeDate(searchParams.get("to"));
  if (from && to && from.getTime() > to.getTime()) {
    return { error: "'from' must be before 'to'" };
  }
  return { from, to };
}

function inRange(date, from, to) {
  if (from && date.getTime() < from.getTime()) return false;
  if (to && date.getTime() > to.getTime()) return false;
  return true;
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

    const { searchParams } = new URL(request.url);
    const window = (searchParams.get("window") || "day").toLowerCase();
    if (!VALID_WINDOWS.has(window)) {
      return NextResponse.json(
        { error: "Invalid 'window'. Expected one of: day, week, month." },
        { status: 400 },
      );
    }

    const range = parseRange(searchParams);
    if (range.error) {
      return NextResponse.json({ error: range.error }, { status: 400 });
    }
    const { from, to } = range;

    const format = (searchParams.get("format") || "csv").toLowerCase();
    if (format !== "csv" && format !== "json") {
      return NextResponse.json(
        { error: "Invalid 'format'. Expected one of: csv, json." },
        { status: 400 },
      );
    }

    const db = await getDb();

    // 1. Fetch materials to get material IDs (owned by this creator).
    const materials = await db.collection("materials")
      .find({ userAddress: creatorAddress }, { projection: { materialId: 1, _id: 1 } })
      .toArray();

    const materialIdStrings = [
      ...new Set(
        materials.flatMap((m) => [String(m._id), String(m.materialId)].filter(Boolean)),
      ),
    ];

    // 2. Fetch purchases for these materials.
    let purchases = [];
    if (materialIdStrings.length > 0) {
      purchases = await db.collection("purchases")
        .find({ materialId: { $in": materialIdStrings } })
        .sort({ purchasedAt: -1, createdAt: -1 })
        .toArray();
    }

    // 3. Fetch payouts for this creator.
    const payouts = await db.collection("payouts")
      .find({ creatorAddress })
      .sort({ createdAt: -1 })
      .toArray();

    // 4. Fetch domain activity (marketplace/learning) for this creator.
    const domainActivity = await db.collection("domainActivity")
      .find({ ownerAddress: creatorAddress })
      .sort({ createdAt: -1 })
      .toArray();

    // 5. Normalize into an internal trend record shape. Private fields
    // (buyer wallets, per-user identifiers) intentionally are not carried
    // into the aggregation output.
    const records = [];

    for (const p of purchases) {
      const date = normalizeDate(p.purchasedAt || p.createdAt || p.updatedAt);
      if (!date || !inRange(date, from, to)) continue;
      records.push({
        date,
        type: "purchase",
        status: p.status || "completed",
        amount: Number(p.amount || 0),
      });
    }

    for (const p of payouts) {
      const date = normalizeDate(p.createdAt || p.updatedAt);
      if (!date || !inRange(date, from, to)) continue;
      records.push({
        date,
        type: "payout",
        status: p.status || "completed",
        amount: -Number(p.amount || 0),
      });
    }

    for (const a of domainActivity) {
      const date = normalizeDate(a.createdAt || a.updatedAt);
      if (!date || !inRange(date, from, to)) continue;
      records.push({
        date,
        type: a.type || "domain",
        status: a.status || "completed",
        amount: Number(a.amount || 0),
      });
    }

    const trends = buildTrends(records, window);

    const report = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      window,
      range: {
        from: from ? from.toISOString() : null,
        to: to ? to.toISOString() : null,
      },
      totalBuckets: trends.length,
      trends: trends.map((t) => ({
        bucket: t.bucket,
        windowStart: t.windowStart,
        windowEnd: t.windowEnd,
        metrics: {
          usageCount: t.usageCount,
          failureCount: t.failureCount,
          recoveryCount: t.recoveryCount,
          domainActivityCount: t.domainActivityCount,
          grossVolume: t.grossVolume,
          netVolume: t.netVolume,
        },
      })),
    };

    if (format === "json") {
      return NextResponse.json(report);
    }

    const csvString = toCsv(trends);
    return new NextResponse(csvString, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="analytics-${creatorAddress}-${window}.csv"`,
        "X-Schema-Version": SCHEMA_VERSION,
      },
    });
  } catch (error) {
    console.error("[analytics/export] GET error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
