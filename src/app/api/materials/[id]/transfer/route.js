export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { requirePermission } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { initiateTransfer, listMaterialTransferHistory } from "@/lib/ownership/ownershipTransfer";
import { serializeTransfer, toMaterialId } from "@/lib/ownership/transferApi";

// POST /api/materials/[id]/transfer  { toAddress, ttlMs?, reason? }
// Owner proposes a transfer. Ownership does not change until the recipient accepts.
export async function POST(request, { params }) {
  return withApiHardening(
    request,
    { route: "materials.transfer.initiate", rateLimit: { limit: 10, windowMs: 60_000 } },
    async () => {
      const authorization = await requirePermission(request, "creator:manage");
      if (!authorization.ok) {
        return NextResponse.json(
          { error: authorization.status === 401 ? "Authentication required" : "Creator access required" },
          { status: authorization.status }
        );
      }
      const user = authorization.user;
      const actorAddress = user.walletAddress || user.address;
      if (!actorAddress) {
        return NextResponse.json({ error: "No wallet address on account" }, { status: 400 });
      }

      const body = await request.json().catch(() => ({}));
      const db = await getDb();
      const { transfer, replayed } = await initiateTransfer(db, {
        materialId: toMaterialId(params?.id),
        actorAddress,
        toAddress: body?.toAddress,
        ttlMs: body?.ttlMs,
        reason: body?.reason,
      });

      auditLog({ event: "ownership_transfer_initiated", route: "materials.transfer.initiate", method: "POST", status: replayed ? 200 : 201, actor: user.sub, materialId: String(transfer.materialId) });
      return NextResponse.json({ transfer: serializeTransfer(transfer), replayed }, { status: replayed ? 200 : 201 });
    }
  );
}

// GET /api/materials/[id]/transfer
// Lists historical and active ownership transfers with audit history for this material.
// Accessible to current owner or admin.
export async function GET(request, { params }) {
  return withApiHardening(
    request,
    { route: "materials.transfer.history", rateLimit: { limit: 20, windowMs: 60_000 } },
    async () => {
      const authorization = await requirePermission(request, "creator:manage");
      if (!authorization.ok) {
        return NextResponse.json(
          { error: authorization.status === 401 ? "Authentication required" : "Creator access required" },
          { status: authorization.status }
        );
      }
      const user = authorization.user;
      const actorAddress = user.walletAddress || user.address;
      if (!actorAddress) {
        return NextResponse.json({ error: "No wallet address on account" }, { status: 400 });
      }

      const db = await getDb();
      const materialId = toMaterialId(params?.id);
      const rows = await listMaterialTransferHistory(db, {
        materialId,
        actorAddress,
        isAdmin: user.role === "admin",
      });

      return NextResponse.json({
        transfers: rows.map((t) => serializeTransfer(t, { includeHistory: true })),
      });
    }
  );
}
