import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { COLLECTIONS } from "@/lib/backend/schemaContracts";
import { getUserFromCookie } from "@/lib/api/auth";
import { ObjectId } from "mongodb";
import { withApiHardening } from "@/lib/api/hardening";

export async function GET(request, { params }) {
  return withApiHardening(request, { route: "webhooks_deliveries" }, async () => {
    const user = await getUserFromCookie(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const db = await getDb();
    const userId = String(user.walletAddress || user.sub || user._id);

    // Verify ownership
    const webhook = await db.collection(COLLECTIONS.webhooks).findOne({ _id: new ObjectId(id), userId });
    if (!webhook) return NextResponse.json({ error: "Webhook not found" }, { status: 404 });

    const deliveries = await db.collection(COLLECTIONS.webhookDeliveries)
      .find({ webhookId: new ObjectId(id) })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    return NextResponse.json({ deliveries });
  });
}
