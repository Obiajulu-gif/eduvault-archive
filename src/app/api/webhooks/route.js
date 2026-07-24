import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { COLLECTIONS } from "@/lib/backend/schemaContracts";
import { getUserFromCookie } from "@/lib/api/auth";
import crypto from "node:crypto";
import { withApiHardening } from "@/lib/api/hardening";

export async function GET(request) {
  return withApiHardening(request, { route: "webhooks_list" }, async () => {
    const user = await getUserFromCookie(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const db = await getDb();
    const userId = user.walletAddress || user.sub || user._id;

    const webhooks = await db.collection(COLLECTIONS.webhooks).find({
      userId: String(userId),
    }).toArray();

    // Redact secrets for GET
    const sanitized = webhooks.map(wh => ({
      ...wh,
      secrets: wh.secrets.map(s => ({ ...s, key: "***REDACTED***" }))
    }));

    return NextResponse.json({ webhooks: sanitized });
  });
}

export async function POST(request) {
  return withApiHardening(request, { route: "webhooks_create" }, async () => {
    const user = await getUserFromCookie(request);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    if (!body.url || !body.url.startsWith('https://')) {
      return NextResponse.json({ error: "Valid HTTPS URL is required" }, { status: 400 });
    }

    const db = await getDb();
    const userId = String(user.walletAddress || user.sub || user._id);

    const secretKey = crypto.randomBytes(32).toString('hex');
    const webhook = {
      userId,
      url: body.url,
      secrets: [{
        key: secretKey,
        createdAt: new Date(),
        expiresAt: null
      }],
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection(COLLECTIONS.webhooks).insertOne(webhook);
    
    // Show secret once upon creation
    return NextResponse.json({ 
      webhook: { ...webhook, _id: result.insertedId },
      secret: secretKey
    });
  });
}
