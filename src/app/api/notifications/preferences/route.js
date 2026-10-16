export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { getUserFromCookie } from "@/lib/api/auth";
import { getDb } from "@/lib/mongodb";
import {
  listNotificationPreferences,
  NotificationPreferenceError,
  setNotificationPreference,
} from "@/lib/notifications/preferences";

export const runtime = "nodejs";

// GET /api/notifications/preferences
// Lists the caller's preferences for optional notification types. Mandatory
// types are not listed because they can't be turned off.
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "notification-preferences", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user?.sub) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

      const preferences = await listNotificationPreferences(await getDb(), user.sub);
      return NextResponse.json({ preferences });
    }
  );
}

// PUT /api/notifications/preferences  { type, enabled }
// Turns one optional notification type on or off for the caller only.
export async function PUT(request) {
  return withApiHardening(
    request,
    { route: "notification-preferences", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user?.sub) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

      const body = await request.json().catch(() => null);
      try {
        const preference = await setNotificationPreference(await getDb(), user.sub, body?.type, body?.enabled);
        return NextResponse.json(preference);
      } catch (err) {
        if (err instanceof NotificationPreferenceError) {
          return NextResponse.json({ error: err.message }, { status: 400 });
        }
        throw err;
      }
    }
  );
}
