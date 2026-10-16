export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { getUserFromCookie } from "@/lib/api/auth";
import { getDb } from "@/lib/mongodb";
import { listNotifications, markNotificationsRead } from "@/lib/notifications/notifications";

export const runtime = "nodejs";

// GET /api/notifications?unread=true&limit=20
// Lists the caller's notifications, newest first, plus their unread count.
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "notifications", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user?.sub) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

      const { searchParams } = new URL(request.url);
      const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 20, 1), 50);
      const result = await listNotifications(await getDb(), user.sub, {
        unreadOnly: searchParams.get("unread") === "true",
        limit,
      });
      return NextResponse.json(result);
    }
  );
}

// PATCH /api/notifications  { ids: [...] } | { all: true }
// Marks the caller's own notifications read; ids belonging to anyone else
// simply don't match.
export async function PATCH(request) {
  return withApiHardening(
    request,
    { route: "notifications", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user?.sub) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

      const body = await request.json().catch(() => null);
      const all = body?.all === true;
      const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === "string").slice(0, 100) : [];
      if (!all && ids.length === 0) {
        return NextResponse.json({ error: "Provide ids or all: true" }, { status: 400 });
      }

      const result = await markNotificationsRead(await getDb(), user.sub, { ids, all });
      return NextResponse.json(result);
    }
  );
}
