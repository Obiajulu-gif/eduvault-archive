export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { renderProblemResponse } from "@/lib/errors/renderErrorResponse";
import { requirePermission } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { listTransfersForUser } from "@/lib/ownership/ownershipTransfer";
import { serializeTransfer } from "@/lib/ownership/transferApi";

// GET /api/ownership-transfers?state=pending&limit=50
// Lists transfers the authenticated user sent or received.
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "ownership-transfers.list", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      const authorization = await requirePermission(request, "creator:manage");
      if (!authorization.ok) {
        return authorization.status === 401
          ? renderProblemResponse("AUTH_UNAUTHENTICATED", request, "Authentication required")
          : renderProblemResponse("AUTH_FORBIDDEN", request, "Creator access required");
      }
      const user = authorization.user;
      const actorAddress = user.walletAddress || user.address;
      if (!actorAddress) {
        return renderProblemResponse("VALIDATION_FIELD", request, "No wallet address on account");
      }

      const { searchParams } = new URL(request.url);
      const state = searchParams.get("state") || undefined;
      const limit = Number(searchParams.get("limit")) || 50;

      const db = await getDb();
      const rows = await listTransfersForUser(db, {
        address: actorAddress,
        state,
        limit,
      });

      return NextResponse.json({
        transfers: rows.map((t) => serializeTransfer(t, { includeHistory: false })),
      });
    }
  );
}

