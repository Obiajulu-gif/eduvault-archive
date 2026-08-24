import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { isAdminRequest } from "@/lib/api/adminAuth";
import { getDb } from "@/lib/mongodb";
import { getOutboxHealth } from "@/lib/backend/outbox";

export const dynamic = "force-dynamic";

export async function GET(request) {
  return withApiHardening(
    request,
    { route: "admin_outbox_health", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      if (!isAdminRequest(request)) {
        auditLog({
          event: "admin_outbox_health_denied",
          route: "admin_outbox_health",
          method: "GET",
          status: 401,
        });
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      try {
        const db = await getDb();
        const health = await getOutboxHealth(db);

        auditLog({
          event: "admin_outbox_health_success",
          route: "admin_outbox_health",
          method: "GET",
          status: 200,
        });

        return NextResponse.json({ success: true, health });
      } catch (err) {
        auditLog({
          event: "admin_outbox_health_failed",
          route: "admin_outbox_health",
          method: "GET",
          status: 500,
          reason: err.message,
        });
        return NextResponse.json(
          { error: err.message || "Failed to read outbox health" },
          { status: 500 }
        );
      }
    }
  );
}
