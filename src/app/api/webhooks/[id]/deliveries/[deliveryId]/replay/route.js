import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { COLLECTIONS } from "@/lib/backend/schemaContracts";
import { getUserFromCookie } from "@/lib/api/auth";
import { ObjectId } from "mongodb";
import { withApiHardening } from "@/lib/api/hardening";

export async function POST(request, { params }) {
  return withApiHardening(request, { route: "webhooks_replay" }, async () => {
    const user = await getUserFromCookie(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id, deliveryId } = await params;
    const db = await getDb();
    const userId = String(user.walletAddress || user.sub || user._id);

    const delivery = await db.collection(COLLECTIONS.webhookDeliveries).findOne({
      _id: new ObjectId(deliveryId),
      webhookId: new ObjectId(id),
      userId
    });

    if (!delivery) return NextResponse.json({ error: "Delivery not found" }, { status: 404 });

    await db.collection(COLLECTIONS.webhookDeliveries).updateOne(
      { _id: new ObjectId(deliveryId) },
      { 
        $set: { 
          status: 'pending', 
          nextAttemptAt: new Date(), 
          updatedAt: new Date() 
        } 
      }
    );

    return NextResponse.json({ success: true, message: "Replay scheduled" });
  });
}
