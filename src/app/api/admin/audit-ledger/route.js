export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { requireAdmin } from "@/lib/api/auth";
import { createAuditCheckpoint, readAuditRecords, verifyAuditRecords } from "@/lib/backend/auditLedger";
import { computeInPact, buildInPactQuery, redactInPact } from "@/lib/backend/incidentImpact";

export async function GET(request) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 });

  try {
    const url = new URL(request.url);
    const rawParams = Object.fromEntries(url.searchParams.entries());
    const params = stripApprovalParams(rawParams);
    const limit = Math.min(Math.max(Number(params.limit) || 1000, 1), 5000);

    const guard = await enforceApproval(request, "export_audit_ledger", rawParams, admin);
    if (guard.error) {
      return NextResponse.json({ error: guard.error }, { status: guard.status });
    }

    const records = await readAuditRecords(await getDb(), { ...params, limit });
    const filtered = Object.keys(params).some((key) => ["action", "actor", "targetType", "operationId", "from", "to"].includes(key));
    return NextResponse.json({
      records,
      exportedAt: new Date().toISOString(),
      approval: guard.approval,
      verification: filtered ? { valid: null, note: "Verify an unfiltered export to validate the complete chain." } : verifyAuditRecords(records),
    });
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
      const query = buildInPactQuery(body.query || {});
      const records = await readAuditRecords(await getDb(), { ...query.auditFilter, limit: query.limit });
      const impact = computeInPact(records, query);
      const shareable = redactInPact(impact);
      return NextResponse.json({
        internal: impact,
        shareable,
        exportedAt: new Date().toISOString(),
      });
    }
    const checkpoint = await createAuditCheckpoint(await getDb());
    return NextResponse.json({ success: true, checkpoint, approval: guard.approval });
  } catch (error) {
    console.error("Audit ledger checkpoint error:", error);
    return NextResponse.json({ error: "Failed to create audit checkpoint" }, { status: 500 });
  }
}
