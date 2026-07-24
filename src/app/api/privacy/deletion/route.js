export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { getUserFromCookie } from "@/lib/api/auth";
import { auditLog } from "@/lib/api/audit";
import {
  createDeletionRequest,
  confirmReauth,
  getDeletionRequest,
  getActiveDeletionRequest,
  DELETION_STATUS,
} from "@/lib/privacy/deletionStateMachine";
import { executeDeletion } from "@/lib/privacy/deletionExecutor";

/**
 * POST /api/privacy/deletion
 * Body: { action: "request" | "confirm_reauth" | "execute" }
 *
 *   action=request        → creates a new deletion request, returns reauthToken
 *   action=confirm_reauth → { requestId, reauthToken } → advances to cooling_off
 *   action=execute        → { requestId } → runs deletion (after cooling-off)
 */
export async function POST(request) {
  return withApiHardening(
    request,
    { route: "privacy_deletion", rateLimit: { limit: 5, windowMs: 60 * 60 * 1000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

      const userId     = user.sub ?? user._id;
      const walletAddr = user.walletAddress ?? user.address ?? null;

      let body;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const { action, requestId, reauthToken } = body ?? {};

      // ── action: request ─────────────────────────────────────────────────
      if (action === "request") {
        const { alreadyExists, request: req } = await createDeletionRequest(
          String(userId),
          walletAddr
        );
        return NextResponse.json({
          requestId:   String(req._id),
          status:      req.status,
          reauthToken: req.reauthToken,
          reauthExpiresAt: req.reauthExpiresAt,
          alreadyExists,
        }, { status: alreadyExists ? 200 : 202 });
      }

      // ── action: confirm_reauth ───────────────────────────────────────────
      if (action === "confirm_reauth") {
        if (!requestId || !reauthToken) {
          return NextResponse.json({ error: "Missing requestId or reauthToken" }, { status: 400 });
        }
        try {
          const result = await confirmReauth(requestId, String(userId), reauthToken);
          return NextResponse.json(result);
        } catch (err) {
          const status =
            err.code === "forbidden"        ? 403 :
            err.code === "reauth_expired"   ? 410 :
            err.code === "invalid_token"    ? 403 :
            err.code === "invalid_transition"? 409 : 500;
          return NextResponse.json({ error: err.message }, { status });
        }
      }

      // ── action: execute ──────────────────────────────────────────────────
      if (action === "execute") {
        if (!requestId) {
          return NextResponse.json({ error: "Missing requestId" }, { status: 400 });
        }
        try {
          const result = await executeDeletion(requestId, String(userId));
          return NextResponse.json(result);
        } catch (err) {
          const status =
            err.code === "forbidden"           ? 403 :
            err.code === "cooling_off_active"  ? 409 :
            err.code === "obligations_blocked" ? 409 :
            err.code === "invalid_transition"  ? 409 : 500;
          return NextResponse.json({ error: err.message, code: err.code }, { status });
        }
      }

      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  );
}

/**
 * GET /api/privacy/deletion?requestId=...
 * Returns the current state of the deletion request.
 * If no requestId provided, returns the user's active request (if any).
 */
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "privacy_deletion_status", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

      const userId = user.sub ?? user._id;
      const { searchParams } = new URL(request.url);
      const requestId = searchParams.get("requestId");

      try {
        let doc;
        if (requestId) {
          doc = await getDeletionRequest(requestId, String(userId));
        } else {
          doc = await getActiveDeletionRequest(String(userId));
        }

        if (!doc) return NextResponse.json({ active: false });

        // Return safe subset (no reauthToken)
        return NextResponse.json({
          active:            true,
          requestId:         String(doc._id),
          status:            doc.status,
          requestedAt:       doc.requestedAt,
          coolingOffEndsAt:  doc.coolingOffEndsAt ?? null,
          completedAt:       doc.completedAt ?? null,
          cancelledAt:       doc.cancelledAt ?? null,
          receiptId:         doc.receiptId ?? null,
          failureReason:     doc.failureReason ?? null,
          obligationBlockReasons: doc.obligationBlockReasons ?? null,
          steps:             doc.steps ?? [],
        });
      } catch (err) {
        if (err.code === "not_found") return NextResponse.json({ active: false });
        if (err.code === "forbidden") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
