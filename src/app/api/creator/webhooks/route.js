import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { requirePermission } from "@/lib/api/auth";
import { validateWebhookUrls, SsrfError } from "@/lib/webhooks/ssrfGuard";
import { canonicalizeWebhookUrls } from "@/lib/canonicalization";

export const dynamic = "force-dynamic";

// Return the creator's currently registered webhook destinations.
// Stored values are already canonical, but legacy records written before
// canonicalization was introduced are normalized on read so equivalent
// inputs are reported consistently.
 export async function GET(request) {
  try {
    const authorization = await requirePermission(request, "creator:manage");
    if (!authorization.ok) {
      return NextResponse.json({ error: "Forbidden" }, { status: authorization.status });
    }
    const user = authorization.user;

    const db = await getDb();
    const users = db.collection("users");
    const profile = await users.findOne(
      { $or: [{ _id: user._id }, { walletAddress: user.walletAddress }] },
      { projection: { webhookUrls: 1 } }
    );

    const rawUrls = Array.isArray(profile?.webhookUrls) ? profile.webhookUrls : [];
    const webhookUrls = canonicalizeWebhookUrls(rawUrls);

    return NextResponse.json({ success: true, webhookUrls });
  } catch (error) {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

// Register (or replace) webhook destinations. Every URL is validated against the
// SSRF / DNS-rebinding policy so private, loopback, metadata, and rebinding
// hosts are blocked at registration time (issue #634).
//
// Before validation, input is strictly normalized and canonicalized so that
// equivalent payloads (whitespace, casing, default ports, trailing slashes,
// duplicates) produce the same stored representation. Non-canonical input
// is either normalized or rejected consistently.
 export async function PUT request) {
  try {
    const authorization = await requirePermission(request, "creator:manage");
    if (!authorization.ok) {
      return NextResponse.json({ error: "Forbidden" }, { status: authorization.status });
    }
    const user = authorization.user;

    const body = await request.json();
    const urls = body.webhookUrls;
    if (!Array.isArray(urls)) {
      return NextResponse.json({ error: "webhookUrls must be an array" }, { status: 400 });
    }

    // Strict normalization + canonical serialization. Rejects non-string
    // entries and non-canonical input consistently.
    let canonicalUrls;
    try {
      canonicalUrls = canonicalizeWebhookUrls(urls);
    } catch (error) {
      return NextResponse.json(
        { error: error.message || "Invalid webhook URLs", code: error.code || "INVALID_INPUT" },
        { status: 400 }
      );
    }

    try {
      await validateWebhookUrls(canonicalUrls);
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
      $set: {
        webhookUrls: canonicalUrls,
        webhookUrlsUpdatedAt: new Date(),
        // Record the canonicalization version so legacy records can be
        // migrated lazily on next write.
        webhookUrlsCanonicalizationVersion: 1,
      },
    });

    return NextResponse.json({ success: true, webhookUrls: canonicalUrls });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to update webhooks" }, { status: 500 });
  }
}

export const POST = PUT;
