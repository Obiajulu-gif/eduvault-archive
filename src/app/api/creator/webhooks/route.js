import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { getUserFromCookie } from "@/lib/api/auth";
import { validateWebhookUrls, SsrfError } from "@/lib/webhooks/ssrfGuard";

export const dynamic = "force-dynamic";

// Return the creator's currently registered webhook destinations.
export async function GET(request) {
  try {
    const user = await getUserFromCookie(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const users = db.collection("users");
    const profile = await users.findOne(
      { $or: [{ _id: user._id }, { walletAddress: user.walletAddress }] },
      { projection: { webhookUrls: 1 } }
    );

    return NextResponse.json({ success: true, webhookUrls: profile?.webhookUrls || [] });
  } catch (error) {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

// Register (or replace) webhook destinations. Every URL is validated against the
// SSRF / DNS-rebinding policy so private, loopback, metadata, and rebinding
// hosts are blocked at registration time (issue #634).
export async function PUT(request) {
  try {
    const user = await getUserFromCookie(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const urls = body.webhookUrls;
    if (!Array.isArray(urls)) {
      return NextResponse.json({ error: "webhookUrls must be an array" }, { status: 400 });
    }

    try {
      await validateWebhookUrls(urls);
    } catch (error) {
      if (error instanceof SsrfError) {
        // Safe diagnostic only — we never reflect the raw host/secret.
        return NextResponse.json(
          { error: "One or more webhook URLs were rejected.", code: error.code },
          { status: 400 }
        );
      }
      throw error;
    }

    const db = await getDb();
    const users = db.collection("users");
    const query = user._id ? { _id: user._id } : { walletAddress: user.walletAddress };
    await users.updateOne(query, {
      $set: { webhookUrls: urls, webhookUrlsUpdatedAt: new Date() },
    });

    return NextResponse.json({ success: true, webhookUrls: urls });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to update webhooks" }, { status: 500 });
  }
}

export const POST = PUT;
