export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { getUserFromCookie } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { auditLog } from "@/lib/api/audit";
import { errorResponse } from "@/lib/utils/errorResponse";

/** Allowed preference keys — keeps the stored shape predictable. */
const ALLOWED_KEYS = [
  "purchaseReceipts",
  "weeklyEarnings",
  "productUpdates",
  "buyConfirmations",
  "newFollower",
  "materialApproved",
];

/**
 * Validate and sanitise the incoming preferences object.
 * Ignores unknown keys; rejects non-boolean values.
 *
 * @param {unknown} raw
 * @returns {{ ok: true; prefs: Record<string, boolean> } | { ok: false; reason: string }}
 */
function parsePreferences(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "preferences must be a plain object" };
  }

  const prefs = {};
  for (const key of ALLOWED_KEYS) {
    if (key in raw) {
      if (typeof raw[key] !== "boolean") {
        return { ok: false, reason: `"${key}" must be a boolean` };
      }
      prefs[key] = raw[key];
    }
  }

  if (Object.keys(prefs).length === 0) {
    return { ok: false, reason: "No valid preference keys provided" };
  }

  return { ok: true, prefs };
}

/** GET /api/profile/email-subscriptions — returns current preferences */
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "email-subscriptions", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      try {
        const session = await getUserFromCookie(request);
        if (!session) {
          return errorResponse({ status: 401, detail: "Unauthorized", instance: "/api/profile/email-subscriptions" });
        }

        const db = await getDb();
        const users = db.collection("users");
        const userId = ObjectId.isValid(session.sub) ? new ObjectId(session.sub) : null;
        const query = userId ? { _id: userId } : { walletAddress: session.walletAddress };

        const user = await users.findOne(query, { projection: { emailSubscriptions: 1 } });
        if (!user) {
          return errorResponse({ status: 404, detail: "User not found", instance: "/api/profile/email-subscriptions" });
        }

        // Return persisted prefs merged with defaults so the client always
        // gets a complete set of keys.
        const defaults = Object.fromEntries(ALLOWED_KEYS.map((k) => [k, true]));
        const emailSubscriptions = { ...defaults, ...(user.emailSubscriptions || {}) };

        return NextResponse.json({ success: true, emailSubscriptions });
      } catch (error) {
        auditLog({ event: "email_subscriptions_get_failed", route: "email-subscriptions", method: "GET", status: 500, reason: error.message });
        return errorResponse({ status: 500, detail: "Server error", instance: "/api/profile/email-subscriptions" });
      }
    }
  );
}

/** PATCH /api/profile/email-subscriptions — partial update of preferences */
export async function PATCH(request) {
  return withApiHardening(
    request,
    { route: "email-subscriptions", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      try {
        const session = await getUserFromCookie(request);
        if (!session) {
          return errorResponse({ status: 401, detail: "Unauthorized", instance: "/api/profile/email-subscriptions" });
        }

        const body = await request.json();
        const result = parsePreferences(body?.emailSubscriptions ?? body);
        if (!result.ok) {
          return errorResponse({ status: 400, detail: result.reason, instance: "/api/profile/email-subscriptions" });
        }

        const db = await getDb();
        const users = db.collection("users");
        const userId = ObjectId.isValid(session.sub) ? new ObjectId(session.sub) : null;
        const query = userId ? { _id: userId } : { walletAddress: session.walletAddress };

        // Build a dot-notation update so unspecified keys are left untouched.
        const setFields = {};
        for (const [key, value] of Object.entries(result.prefs)) {
          setFields[`emailSubscriptions.${key}`] = value;
        }
        setFields.updatedAt = new Date().toISOString();

        const updateResult = await users.updateOne(query, { $set: setFields });
        if (updateResult.matchedCount === 0) {
          return errorResponse({ status: 404, detail: "User not found", instance: "/api/profile/email-subscriptions" });
        }

        const updated = await users.findOne(query, { projection: { emailSubscriptions: 1 } });
        const defaults = Object.fromEntries(ALLOWED_KEYS.map((k) => [k, true]));
        const emailSubscriptions = { ...defaults, ...(updated?.emailSubscriptions || {}) };

        auditLog({ event: "email_subscriptions_updated", route: "email-subscriptions", method: "PATCH", status: 200 });
        return NextResponse.json({ success: true, emailSubscriptions });
      } catch (error) {
        auditLog({ event: "email_subscriptions_update_failed", route: "email-subscriptions", method: "PATCH", status: 500, reason: error.message });
        return errorResponse({ status: 500, detail: "Server error", instance: "/api/profile/email-subscriptions" });
      }
    }
  );
}
