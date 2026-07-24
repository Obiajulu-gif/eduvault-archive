import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { COLLECTIONS } from "@/lib/backend/schemaContracts";
import { getUserFromCookie } from "@/lib/api/auth";
import { ObjectId } from "mongodb";
import { withApiHardening } from "@/lib/api/hardening";

export async function DELETE(request, { params }) {
  return withApiHardening(request, { route: "webhooks_delete" }, async () => {
    const user = await getUserFromCookie(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const db = await getDb();
    const userId = String(user.walletAddress || user.sub || user._id);

    const result = await db.collection(COLLECTIONS.webhooks).updateOne(
      { _id: new ObjectId(id), userId },
      { $set: { status: 'disabled', updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return NextResponse.json({ error: "Webhook not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  });
}
