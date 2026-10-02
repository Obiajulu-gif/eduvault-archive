export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { requireAdmin } from "@/lib/api/auth";
import { createAuditCheckpoint, readAuditRecords, verifyAuditRecords } from "@/lib/backend/auditLedger";
import { createReceipt } from "@/lib/receipts/receiptService";
import { canonicalizeAuditRecords, canonicalizePayload } from "@/lib/backend/canonicalSerialization";

export async function GET(request) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 });

  try {
    const url = new URL(request.url);
    const rawParams = Object.fromEntries(url.searchParams.entries());
    const params = rawParams;
    const limit = Math.min(Math.max(Number(params.limit) || 1000, 1), 5000);
    const rawRecords = await readAuditRecords(await getDb(), { ...params, limit });
    const records = canonicalizeAuditRecords(rawRecords);
    const filtered = Object.keys(params).some((key) => ["action", "actor", "targetType", "operationId", "from", "to"].includes(key));
    return NextResponse.json(canonicalizePayload({
      records,
      exportedAt: new Date().toISOString(),
      
      verification: filtered ? { valid: null, note: "Verify an unfiltered export to validate the complete chain." } : verifyAuditRecords(records),
    }));
  } catch (error) {
    console.error("Audit ledger export error:", error);
    return NextResponse.json({ error: "Failed to export audit ledger" }, { status: 500 });
  }
}

export async function POST(request) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 });
  try {
const body = await request.json().catch(() => ({}));
    if (body && body.action === "impact") {
      const query = { auditFilter: body.query || {}, limit: 1000 };
      const records = await readAuditRecords(await getDb(), { ...query.auditFilter, limit: query.limit });
      const impact = { recordsCount: records.length };
      const shareable = { recordsCount: records.length };
      return NextResponse.json({
        internal: impact,
        shareable,
        exportedAt: new Date().toISOString(),
      });
    }
    const db = await getDb();
    const checkpoint = await createAuditCheckpoint(db);
    const { receipt } = await createReceipt({
      operation: "audit.checkpoint",
      actor: admin.id || admin.email || "admin",
      status: "succeeded",
      references: { checkpointId: checkpoint?.id || null },
      db,
    });
    return NextResponse.json(canonicalizePayload({ success: true, checkpoint, receipt }));
  } catch (error) {
    console.error("Audit ledger checkpoint error:", error);
    return NextResponse.json({ error: "Failed to create audit checkpoint" }, { status: 500 });
  }
}
