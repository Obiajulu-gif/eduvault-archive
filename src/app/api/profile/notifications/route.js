export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { getUserFromCookie } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import {
  normalizeNotificationPreferences,
  validateNotificationPreferencesPayload,
} from "@/lib/api/validation";
import { getDb } from "@/lib/mongodb";
import { getUserQuery, getUserIdString } from "@/lib/profile/accountData";

export async function GET(request) {
  return withApiHardening(
    request,
    { route: "profile.notifications", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      try {
        const sessionUser = await getUserFromCookie(request);
        if (!sessionUser) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const db = await getDb();
        const user = await db.collection("users").findOne(getUserQuery(sessionUser));
        if (!user) {
          return NextResponse.json({ error: "User not found" }, { status: 404 });
        }

        return NextResponse.json({
          notificationPreferences: normalizeNotificationPreferences(user.notificationPreferences),
        });
      } catch (error) {
        auditLog({
          event: "profile_notifications_read_failed",
          route: "profile.notifications",
          method: "GET",
          status: 500,
          reason: error.message,
        });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}

export async function PATCH(request) {
  return withApiHardening(
    request,
    { route: "profile.notifications", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      try {
        const sessionUser = await getUserFromCookie(request);
        if (!sessionUser) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const preferences = validateNotificationPreferencesPayload(await request.json());
        const db = await getDb();
        const users = db.collection("users");
        const query = getUserQuery(sessionUser);
        const result = await users.updateOne(
          query,
          {
            $set: {
              notificationPreferences: preferences,
              updatedAt: new Date().toISOString(),
            },
          }
        );

        if (result.matchedCount === 0) {
          return NextResponse.json({ error: "User not found" }, { status: 404 });
        }

        auditLog({
          event: "profile_notifications_updated",
          route: "profile.notifications",
          method: "PATCH",
          status: 200,
          actor: getUserIdString(sessionUser),
        });

        return NextResponse.json({ success: true, notificationPreferences: preferences });
      } catch (error) {
        if (error.name === "ValidationError") throw error;
        auditLog({
          event: "profile_notifications_update_failed",
          route: "profile.notifications",
          method: "PATCH",
          status: 500,
          reason: error.message,
        });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
