export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireActiveUser } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { OperationHistoryError, getOperationHistory } from "@/lib/operations/operationHistory";
import { errorResponse } from "@/lib/utils/errorResponse";

/**
 * GET /api/operations/history — the caller's own operation history (#882).
 *
 * Query: `category`, `type`, `from`, `to` (ISO dates), `limit` (≤ 100), and
 * `cursor` (the `nextCursor` of the previous page, valid only with the same
 * filters).
 */
export async function GET(request) {
  return withApiHardening(request, { route: "operations-history", rateLimit: { limit: 60, windowMs: 60_000 } }, async () => {
    const auth = await requireActiveUser(request);
    if (!auth.ok) {
      return errorResponse({ status: auth.status || 401, detail: "Authentication required", request });
    }

    const params = Object.fromEntries(new URL(request.url).searchParams);
    try {
      const page = await getOperationHistory({ db: await getDb(), user: auth.user, query: params });
      return NextResponse.json(page, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      if (error instanceof OperationHistoryError) {
        return errorResponse({ status: error.status, detail: error.message, request });
      }
      throw error;
    }
  });
}
