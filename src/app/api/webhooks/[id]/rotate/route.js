import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { COLLECTIONS } from "@/lib/backend/schemaContracts";
import { getUserFromCookie } from "@/lib/api/auth";
import { ObjectId } from "mongodb";
import crypto from "node:crypto";
import { withApiHardening } from "@/lib/api/hardening";

export async function POST(request, { params }) {
  return withApiHardening(request, { route: "webhooks_rotate" }, async () => {
    const user = await getUserFromCookie(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const db = await getDb();
    const userId = String(user.walletAddress || user.sub || user._id);

    const webhook = await db.collection(COLLECTIONS.webhooks).findOne({
      _id: new ObjectId(id), userId
    });

    if (!webhook) return NextResponse.json({ error: "Webhook not found" }, { status: 404 });

    const newSecret = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    // Overlapping key rotation: old keys expire in 24h
    const expiration = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    
    const updatedSecrets = webhook.secrets.map(s => 
      s.expiresAt ? s : { ...s, expiresAt: expiration }
    );
    updatedSecrets.push({
      key: newSecret,
      createdAt: now,
      expiresAt: null
    });

    await db.collection(COLLECTIONS.webhooks).updateOne(
      { _id: new ObjectId(id) },
      { $set: { secrets: updatedSecrets, updatedAt: now } }
    );

    return NextResponse.json({ success: true, secret: newSecret });
  });
}
