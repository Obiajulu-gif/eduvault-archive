export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { renderProblemResponse } from "@/lib/errors/renderErrorResponse";
import { auditLog } from "@/lib/api/audit";
import { requirePermission } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { invalidateCatalogCache } from "@/lib/cache/redis";
import { enqueueMaterialSearchProjection } from "@/lib/backend/materialSearchProjection";
import { acceptTransfer, cancelTransfer, declineTransfer, getTransfer } from "@/lib/ownership/ownershipTransfer";
import { serializeTransfer } from "@/lib/ownership/transferApi";

const ACTIONS = new Set(["accept", "decline", "cancel"]);

// POST /api/ownership-transfers/[transferId]  { action: "accept" | "decline" | "cancel" }
//   accept / decline: the named recipient only.
//   cancel: the proposing owner, or an admin.
export async function POST(request, { params }) {
  return withApiHardening(
    request,
    { route: "ownership-transfers.action", rateLimit: { limit: 20, windowMs: 60_000 } },
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

      const body = await request.json().catch(() => ({}));
      if (!ACTIONS.has(body?.action)) {
        return renderProblemResponse("VALIDATION_FIELD", request, 'action must be "accept", "decline" or "cancel".');
      }

      const db = await getDb();
      const transferId = params?.transferId;
      let result;
      if (body.action === "accept") {
        result = await acceptTransfer(db, { transferId, actorAddress });
      } else if (body.action === "decline") {
        result = await declineTransfer(db, { transferId, actorAddress });
      } else {
        result = await cancelTransfer(db, { transferId, actorAddress, isAdmin: user.role === "admin" });
      }

      // Re-run side effects even on a replayed accept: they are idempotent and
      // a previous attempt may have died before reaching them.
      if (body.action === "accept" && (result.material || result.replayed)) {
        const material = result.material || (await db.collection("materials").findOne({ _id: result.transfer.materialId }));
        if (material) {
          await enqueueMaterialSearchProjection({ db, material, reason: "material_ownership_transferred" });
          await invalidateCatalogCache();
        }
      }

      auditLog({ event: `ownership_transfer_${body.action}`, route: "ownership-transfers.action", method: "POST", status: 200, actor: user.sub, materialId: String(result.transfer.materialId) });
      return NextResponse.json({ transfer: serializeTransfer(result.transfer), replayed: result.replayed });
    }
  );
}

// GET /api/ownership-transfers/[transferId]
// Returns transfer details including expiry status and full audit history.
// Authorized only for transfer parties (proposer, recipient) or admin.
export async function GET(request, { params }) {
  return withApiHardening(
    request,
    { route: "ownership-transfers.get", rateLimit: { limit: 30, windowMs: 60_000 } },
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

      const db = await getDb();
      const transferId = params?.transferId;
      const { transfer } = await getTransfer(db, {
        transferId,
        actorAddress,
        isAdmin: user.role === "admin",
        includeHistory: true,
      });

      auditLog({
        event: "ownership_transfer_inspected",
        route: "ownership-transfers.get",
        method: "GET",
        status: 200,
        actor: user.sub,
        materialId: String(transfer.materialId),
      });

      return NextResponse.json({
        transfer: serializeTransfer(transfer, { includeHistory: true }),
      });
    }
  );
}
