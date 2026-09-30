export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { requireAdmin } from "@/lib/api/auth";
import {
  exportProvenance,
  summarizeProvenance,
  traceProvenance,
  provenanceToCsv,
  PROVENANCE_KINDS,
} from "@/lib/backend/provenance";

// Fields a maintainer needs to audit provenance without pulling storage keys
// or full listing bodies into memory.
const PROJECTION = { title: 1, externalId: 1, userAddress: 1, isDeleted: 1, provenance: 1 };

// GET /api/admin/provenance
// Maintainer export of provenance rows. Filters: kind, importBatchId, actor,
// materialId, limit. `format=csv` streams a spreadsheet-friendly export.
// See docs/provenance.md (#888).
export async function GET(request) {
  const admin = await requireAdmin(request);
  if (!admin) return NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 403 });

  try {
    const params = new URL(request.url).searchParams;
    const limit = Math.min(Math.max(Number(params.get("limit")) || 500, 1), 5000);

    const kind = params.get("kind");
    const importBatchId = params.get("importBatchId");
    const actor = params.get("actor");
    const materialId = params.get("materialId");

    const query = {};
    if (kind) query["provenance.kind"] = kind;
    if (importBatchId) query["provenance.origin.importBatchId"] = importBatchId;
    if (actor) query["provenance.actor.walletAddress"] = actor;
    if (materialId && ObjectId.isValid(materialId)) query._id = new ObjectId(materialId);

    const db = await getDb();
    const materials = db.collection("materials");
    const records = await materials
      .find(query, { projection: PROJECTION })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();

    // Preload the ancestor closure for derived rows so tracing needs no extra
    // queries and a deleted source still resolves to its tombstone instead of
    // a false "not found".
    const cache = new Map();
    let frontier = records
      .filter((record) => record?.provenance?.kind === PROVENANCE_KINDS.DERIVED)
      .map((record) => record.provenance.origin?.materialId)
      .filter((id) => id && ObjectId.isValid(id));

    for (let depth = 0; depth < 10 && frontier.length > 0; depth += 1) {
      const sourceDocs = await materials
        .find({ _id: { $in: frontier.map((id) => new ObjectId(id)) } }, { projection: PROJECTION })
        .toArray();
      frontier = [];
      for (const source of sourceDocs) {
        cache.set(String(source._id), source);
        const next = source.provenance?.origin?.materialId;
        if (next && ObjectId.isValid(next) && !cache.has(String(next))) frontier.push(next);
      }
    }

    const resolveSource = (id) => cache.get(String(id)) || null;
    const traces = {};
    for (const record of records) {
      if (record?.provenance?.kind === PROVENANCE_KINDS.DERIVED) {
        traces[String(record._id)] = traceProvenance(record.provenance, { resolveSource });
      }
    }

    const rows = exportProvenance(records, { traces });
    const summary = summarizeProvenance(rows);

    if (params.get("format") === "csv") {
      return new NextResponse(provenanceToCsv(rows), {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="eduvault-provenance-${Date.now()}.csv"`,
        },
      });
    }

    return NextResponse.json({
      rows,
      summary,
      exportedAt: new Date().toISOString(),
      filters: {
        kind: kind || null,
        importBatchId: importBatchId || null,
        actor: actor || null,
        materialId: materialId || null,
      },
    });
  } catch (error) {
    console.error("Provenance export error:", error);
    return NextResponse.json({ error: "Failed to export provenance" }, { status: 500 });
  }
}
