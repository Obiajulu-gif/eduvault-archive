export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { getUserFromCookie } from "@/lib/api/auth";
import { getDb } from "@/lib/mongodb";
import { getDeliveryDiagnostics } from "@/lib/notifications/notifications";

export const runtime = "nodejs";

// GET /api/notifications/delivery-receipts?limit=50
// Returns delivery-failure diagnostics and receipt refs for the current user.
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "notification-delivery-receipts", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user?.sub) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

      const { searchParams } = new URL(request.url);
      const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 50, 1), 100);
      const receipts = await getDeliveryDiagnostics(await getDb(), user.sub, { limit });
      return NextResponse.json({ receipts });
    }
  );
}
