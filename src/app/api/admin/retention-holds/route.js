export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { requirePermission } from "@/lib/api/auth";
import {
  createRetentionHold,
  listRetentionHolds,
  releaseRetentionHold,
} from "@/lib/privacy/retentionHolds";

export async function GET(request) {
  try {
    const auth = await requirePermission(request, "admin:retention_holds:read");
    if (!auth.ok) {
      return NextResponse.json(
        { error: auth.status === 401 ? "Unauthorized" : "Forbidden" },
        { status: auth.status }
      );
    }

    const { searchParams } = new URL(request.url);
    const filters = {
      status: searchParams.get("status") || undefined,
      investigationType: searchParams.get("investigationType") || undefined,
      caseId: searchParams.get("caseId") || undefined,
      targetCollection: searchParams.get("targetCollection") || undefined,
    };

    const db = await getDb();
    const result = await listRetentionHolds({
      db,
      actorContext: auth.user,
      filters,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.code, message: result.message }, { status: result.status });
    }

    return NextResponse.json({ holds: result.holds }, { status: 200 });
  } catch (error) {
    console.error("[admin/retention-holds] GET error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const auth = await requirePermission(request, "admin:retention_holds:manage");
    if (!auth.ok) {
      return NextResponse.json(
        { error: auth.status === 401 ? "Unauthorized" : "Forbidden" },
        { status: auth.status }
      );
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "INVALID_JSON", message: "Invalid JSON payload." }, { status: 400 });
    }

    const headerKey = request.headers.get("idempotency-key");
    const input = {
      ...body,
      idempotencyKey: body.idempotencyKey || headerKey || undefined,
    };

    const db = await getDb();
    const result = await createRetentionHold({
      db,
      actorContext: auth.user,
      input,
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          error: result.code,
          message: result.message,
          ...(result.missingRecordIds ? { missingRecordIds: result.missingRecordIds } : {}),
          ...(result.rolledBack !== undefined ? { rolledBack: result.rolledBack } : {}),
        },
        { status: result.status }
      );
    }

    return NextResponse.json(
      {
        hold: result.hold,
        idempotent: result.idempotent,
      },
      { status: result.status }
    );
  } catch (error) {
    console.error("[admin/retention-holds] POST error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const auth = await requirePermission(request, "admin:retention_holds:manage");
    if (!auth.ok) {
      return NextResponse.json(
        { error: auth.status === 401 ? "Unauthorized" : "Forbidden" },
        { status: auth.status }
      );
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "INVALID_JSON", message: "Invalid JSON payload." }, { status: 400 });
    }

    const db = await getDb();
    const result = await releaseRetentionHold({
      db,
      actorContext: auth.user,
      holdId: body.holdId,
      releaseReason: body.releaseReason,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.code, message: result.message }, { status: result.status });
    }

    return NextResponse.json(
      {
        hold: result.hold,
        idempotent: result.idempotent,
      },
      { status: result.status }
    );
  } catch (error) {
    console.error("[admin/retention-holds] PATCH error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
