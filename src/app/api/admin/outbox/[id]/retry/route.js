import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { isAdminRequest } from "@/lib/api/adminAuth";
import { getDb } from "@/lib/mongodb";
import { retryFailedOutboxIntent } from "@/lib/backend/outbox";

export const dynamic = "force-dynamic";

export async function POST(request, context) {
  return withApiHardening(
    request,
    { route: "admin_outbox_retry", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      if (!isAdminRequest(request)) {
        auditLog({
          event: "admin_outbox_retry_denied",
          route: "admin_outbox_retry",
          method: "POST",
          status: 401,
        });
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const { id } = await context.params;
      if (!id) {
        return NextResponse.json({ error: "Intent id is required" }, { status: 400 });
      }

      try {
        const db = await getDb();
        const intent = await retryFailedOutboxIntent(db, id);

        if (!intent) {
          auditLog({
            event: "admin_outbox_retry_not_found",
            route: "admin_outbox_retry",
            method: "POST",
            status: 404,
          });
          return NextResponse.json(
            { error: "Outbox intent not found or not in failed state" },
            { status: 404 }
          );
        }

        auditLog({
          event: "admin_outbox_retry_success",
          route: "admin_outbox_retry",
          method: "POST",
          status: 200,
        });

        return NextResponse.json({ success: true, intent });
      } catch (err) {
        auditLog({
          event: "admin_outbox_retry_failed",
          route: "admin_outbox_retry",
          method: "POST",
          status: 500,
          reason: err.message,
        });
        return NextResponse.json(
          { error: err.message || "Failed to retry outbox intent" },
          { status: 500 }
        );
      }
    }
  );
}
