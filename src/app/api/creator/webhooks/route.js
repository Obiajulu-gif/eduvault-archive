import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { requirePermission } from "@/lib/api/auth";
import { validateWebhookUrls, SsrfError } from "@/lib/webhooks/ssrfGuard";
import { verifyWebhookSignature } from "@/lib/webhooks/signature";
import { recordWebhookEvent } from "@/lib/webhooks/replayGuard";
import { canonicalizeWebhookUrls } from "@/lib/canonicalization";

export const dynamic = "force-dynamic";

const DEFAULT_REPLAY_WINDOW_SECONDS = 5 * 60;

function jsonError(status, code, message, extra = {}) {
  return NextResponse.json({ error: message, code...extra }, { status });
}

function getReplayWindowSeconds() {
  const raw = parseInt(process.env.WEBHOOK_REPLAY_WNDOW_SECONDS ?? "", 10);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return DEFAULT_REPLAY_WINDOW_SECONDS;
}

function getSignatureHeaders(request) {
  const h = request.headers;
  return {
    signature:
      h.get("x-eduvault-signature") ??
      h.get("x-hub-signature-256") ??
      h.get("x-signature-256") ??
      h.get("x-webhook-signature"),
    timestamp:
      h.get("x-eduvault-timestamp") ??
      h.get("x-webhook-timestamp") ??
      h.get("x-timestamp"),
    eventId:
      h.get("x-eduvault-event-id") ??
      h.get("x-webhook-id") ??
      h.get("x-github-delivery") ??
      h.get("x-event-id"),
  };
}

function normalizeEventId(eventId) {
  if (typeof eventId !== "string") {
    return null;
  }
  const trimmed = eventId.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > 256) {
    return null;
  }
  return trimmed;
}

function normalizeTimestamp(timestamp) {
  if (timestamp == null || timestamp === "") {
    return null;
  }
  const as = String(timestamp).trim();
  if (!/^\d+$/.test(as)) {
    return NaN;
  }
  const n = Number(as);
  if (!Number.isSafeInteger(n)) {
    return NaN;
  }
  // Accept either seconds or milliseconds epoch values.
  return n > 1e12 ? Math.floor(n / 1000) : n;
}

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
// SSRF/ DNS-rebinding policy so private, loopback, metadata, and rebinding
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

// Inbound webhook / integration callback receiver. The raw body is verified
// cryptographically against the configured secret, the timestamp is checked
// against the replay window, and the event ID is persisted so duplicate
// deliveries do not repeat side effects.
export async function POST(request) {
  try {
    const user = await getUserFromCookie(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rawBody = await request.text();
    if (!rawBody) {
      return jsonError(400, "invalid_payload", "Request body is required.");
    }

    const { signature, timestamp, eventId } = getSignatureHeaders(request);

    if (!signature) {
      return jsonError(400, "missing_signature", "Missing webhook signature header.");
    }

    const normalizedTimestamp = normalizeTimestamp(timestamp);
    if (normalizedTimestamp === null) {
      return jsonError(400, "missing_timestamp", "Missing webhook timestamp header.");
    }
    if (Number.isNaN(normalizedTimestamp)) {
      return jsonError(400, "invalid_timestamp", "Webhook timestamp header is malformed.");
    }

    const normalizedEventId = normalizeEventId(eventId);
    if (!normalizedEventId) {
      return jsonError(400, "missing_event_id", "Missing or malformed webhook event ID header.");
    }

    const windowSeconds = getReplayWindowSeconds();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const drift = Math.abs(nowSeconds - normalizedTimestamp);
    if (drift > windowSeconds) {
      return jsonError(400, "stale_timestamp", "Webhook timestamp is outside the allowed replay window.", {
        windowSeconds: windowSeconds,
      });
    }

    const signatureResult = verifyWebhookSignature({
      rawBody,
      signature,
      timestamp: normalizedTimestamp,
    });
    if (!signatureResult.valid) {
      return jsonError(401, "invalid_signature", "Webhook signature verification failed.");
    }

    const db = await getDb();
    const recordResult = await recordWebhookEvent(db, {
      eventId: normalizedEventId,
      timestamp: normalizedTimestamp,
      userId: user._id ?? null,
      walletAddress: user.walletAddress ?? null,
    });

    if (!recordResult.recorded) {
      return jsonError(409, "duplicate_event", "Webhook event has already been processed.", {
        eventId: normalizedEventId,
      });
    }

    return NextResponse.json({
      success: true,
      eventId: normalizedEventId,
      receivedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to process webhook" }, { status: 500 });
  }
}
