import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { getUserFromCookie } from "@/lib/api/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

    // 4. Combine and format records
    const records = [];

    // Map purchases
    for (const p of purchases) {
      const date = new Date(p.purchasedAt || p.createdAt || p.updatedAt || 0).toISOString();
      records.push({
        date,
        itemId: String(p.materialId || "Unknown"),
        buyerWallet: String(p.buyerAddress || "Unknown"),
        price: p.amount || 0,
        paidAsset: p.currency || "XLM",
        status: p.status || "completed"
      });
    }

    // Map payouts
    for (const p of payouts) {
      const date = new Date(p.createdAt || p.updatedAt || 0).toISOString();
      records.push({
        date,
        itemId: "Payout",
        buyerWallet: "EduVault",
        price: `-${p.amount || 0}`,
        paidAsset: p.currency || "XLM",
        status: p.status || "completed"
      });
    }

    // Sort combined records by date descending
    records.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // 5. Generate CSV
    const headers = ["Date", "Item ID", "Buyer Wallet", "Price", "Paid Asset", "Status"];
    const csvRows = [headers.join(",")];

    for (const r of records) {
      const row = [
        r.date,
        `"${r.itemId}"`,
        `"${r.buyerWallet}"`,
        r.price,
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
