import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { requirePermission } from "@/lib/api/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

    const db = await getDb();
    
    // 1. Fetch materials to get material IDs
    const materials = await db.collection("materials")
      .find({ userAddress: creatorAddress }, { projection: { materialId: 1, _id: 1 } })
      .toArray();

    const materialIdStrings = [...new Set(materials.flatMap(m => [String(m._id), String(m.materialId)].filter(Boolean)))];

    // 2. Fetch purchases for these materials
    let purchases = [];
    if (materialIdStrings.length > 0) {
      purchases = await db.collection("purchases")
        .find({ materialId: { $in: materialIdStrings } })
        .sort({ purchasedAt: -1, createdAt: -1 })
        .toArray();
    }

    // 3. Fetch payouts for this creator
    const payouts = await db.collection("payouts")
      .find({ creatorAddress })
      .sort({ createdAt: -1 })
      .toArray();

    // 4. Aggregate creator-owned financial records by safe dimensions. Do not
    // export buyer identifiers or a per-learner transaction trail.
    const buckets = new Map();
    const addToBucket = (record) => {
      const key = [record.date, record.itemId, record.paidAsset, record.status].join("\u0000");
      const current = buckets.get(key) || { ...record, transactionCount: 0, totalAmount: 0 };
      current.transactionCount += 1;
      current.totalAmount += Number(record.amount) || 0;
      buckets.set(key, current);
    };

    for (const p of purchases) {
      addToBucket({
        date: new Date(p.purchasedAt || p.createdAt || p.updatedAt || 0).toISOString().slice(0, 10),
        itemId: String(p.materialId || "Unknown"),
        amount: p.amount,
        paidAsset: p.currency || "XLM",
        status: p.status || "completed",
      });
    }

    for (const p of payouts) {
      addToBucket({
        date: new Date(p.createdAt || p.updatedAt || 0).toISOString().slice(0, 10),
        itemId: "Payout",
        amount: -(Number(p.amount) || 0),
        paidAsset: p.currency || "XLM",
        status: p.status || "completed",
      });
    }
    const records = [...buckets.values()];

    // Sort combined records by date descending
    records.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // 5. Generate CSV
    const headers = ["Date", "Item ID", "Transaction Count", "Total Amount", "Paid Asset", "Status"];
    const csvRows = [headers.join(",")];

    for (const r of records) {
      const row = [
        r.date,
        `"${r.itemId}"`,
        r.transactionCount,
        r.totalAmount,
        r.paidAsset,
        r.status
      ];
      csvRows.push(row.join(","));
    }

    const csvString = csvRows.join("\n");

    return new NextResponse(csvString, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="analytics-${creatorAddress}.csv"`,
      },
    });

  } catch (error) {
    console.error("[analytics/export] GET error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
