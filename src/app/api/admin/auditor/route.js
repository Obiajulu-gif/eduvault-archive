export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { requireAdmin, requireActiveUser } from "@/lib/api/auth";
import {
  getAuditorProvenanceAndEntitlements,
  validateAuditorAuthorization,
} from "@/lib/audit/auditorViewService";
import { provenanceToCsv } from "@/lib/backend/provenance";

export async function GET(request) {
  try {
    let user = await requireAdmin(request);
    if (!user) {
      const active = await requireActiveUser(request);
      if (active.ok) {
        user = active.user;
      }
    }
    validateAuditorAuthorization(user);
  } catch (authErr) {
    const status = authErr.statusCode || authErr.status || 403;
    return NextResponse.json(
      {
        error: authErr.message || "Unauthorized: Auditor or administrative privileges required.",
        code: authErr.code || "AUTH_FORBIDDEN",
      },
      { status }
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const materialId = searchParams.get("materialId");
    const buyerAddress = searchParams.get("buyerAddress");
    const kind = searchParams.get("kind");
    const importBatchId = searchParams.get("importBatchId");
    const actor = searchParams.get("actor");
    const limit = searchParams.get("limit");
    const format = searchParams.get("format");

    const db = await getDb();
    const data = await getAuditorProvenanceAndEntitlements(db, {
      materialId,
      buyerAddress,
      kind,
      importBatchId,
      actor,
      limit,
    });

    if (format === "csv") {
      const csv = provenanceToCsv(data.provenance.rows);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="auditor-provenance-${Date.now()}.csv"`,
        },
      });
    }

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (err) {
    console.error("Auditor view API error:", err);
    return NextResponse.json(
      {
        error: "Failed to generate auditor view for provenance and entitlements.",
        code: "SERVER_ERROR",
        details: err.message,
      },
      { status: 500 }
    );
  }
}
