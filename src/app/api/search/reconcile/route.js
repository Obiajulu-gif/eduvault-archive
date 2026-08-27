export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/api/auth";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { reconcileMaterialSearch } from "@/lib/backend/materialSearchProjection";
import { getDb } from "@/lib/mongodb";

export async function POST(request) {
  return withApiHardening(
    request,
    { route: "search-reconcile", rateLimit: { limit: 20, windowMs: 60_000 } },
    async () => {
      const admin = await requireAdmin(request);
      if (!admin) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      try {
        const body = await request.json().catch(() => ({}));
        const batchSize = Math.min(500, Math.max(1, Number(body.batchSize || 100)));
        const result = await reconcileMaterialSearch({
          db: await getDb(),
          cursor: body.cursor || null,
          batchSize,
          repair: body.repair === true,
          runId: body.runId || undefined,
        });

        auditLog({
          event: "search_reconciliation_batch",
          route: "search/reconcile",
          method: "POST",
          status: 200,
          actor: admin.sub,
          checked: result.checked,
          diffCount: result.diff.length,
          repaired: result.repaired,
        });

        return NextResponse.json(result);
      } catch (err) {
        auditLog({
          event: "search_reconciliation_failed",
          route: "search/reconcile",
          method: "POST",
          status: 500,
          actor: admin.sub,
          reason: err.message,
        });
        return NextResponse.json({ error: "Search reconciliation failed" }, { status: 500 });
      }
    },
  );
}
