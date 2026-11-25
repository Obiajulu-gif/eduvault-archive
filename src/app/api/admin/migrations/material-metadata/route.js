export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireActiveUser, requireAdmin } from "@/lib/api/auth";
import { getDb } from "@/lib/mongodb";
import { isAppError } from "@/lib/errors/AppError";
import {
  CURRENT_METADATA_VERSION,
  getMaterialMetadataMigrationStatus,
  migrateMaterialMetadata,
  retryMaterialMetadataMigration,
  rollbackMaterialMetadataMigration,
} from "@/lib/migrations/materialMetadataMigration";

function actorFromAdmin(admin) {
  return {
    id: admin.walletAddress || admin.sub || admin.id || "admin",
    role: admin.role || "admin",
  };
}

async function resolveAdmin(request) {
  const admin = await requireAdmin(request);
  if (admin) return { ok: true, actor: actorFromAdmin(admin) };

  const active = await requireActiveUser(request);
  const authenticated = active.ok;
  return {
    ok: false,
    response: NextResponse.json(
      {
        error: authenticated ? "Admin access required." : "Authentication required.",
        code: authenticated ? "AUTH_FORBIDDEN" : "AUTH_UNAUTHENTICATED",
      },
      { status: authenticated ? 403 : 401 }
    ),
  };
}

function mapAppError(error) {
  if (isAppError(error)) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        details: error.details,
      },
      { status: error.status || 400 }
    );
  }
  return NextResponse.json(
    { error: "Internal server error.", code: "INTERNAL" },
    { status: 500 }
  );
}

export async function GET(request) {
  const auth = await resolveAdmin(request);
  if (!auth.ok) return auth.response;

  try {
    const db = await getDb();
    const url = new URL(request.url);
    const limitParam = Number(url.searchParams.get("limit") || 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 50) : 10;
    const status = await getMaterialMetadataMigrationStatus(db, { limit });
    return NextResponse.json(status);
  } catch (error) {
    console.error("GET /api/admin/migrations/material-metadata error:", error);
    return mapAppError(error);
  }
}

export async function POST(request) {
  const auth = await resolveAdmin(request);
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body.", code: "INVALID_JSON" },
      { status: 400 }
    );
  }

  const payload = body && typeof body === "object" ? body : {};
  const action = payload.action || "migrate";

  try {
    const db = await getDb();

    if (action === "migrate") {
      const result = await migrateMaterialMetadata(db, {
        actor: auth.actor,
        targetVersion: payload.targetVersion ?? CURRENT_METADATA_VERSION,
        runId: payload.runId,
        dryRun: payload.dryRun === true,
        batchSize: payload.batchSize,
        filter: payload.filter && typeof payload.filter === "object" ? payload.filter : {},
        autoRollback: payload.autoRollback !== false,
        maxRetries: payload.maxRetries,
      });
      return NextResponse.json(result);
    }

    if (action === "rollback") {
      const result = await rollbackMaterialMetadataMigration(db, {
        actor: auth.actor,
        runId: payload.runId,
        force: payload.force === true,
        maxRetries: payload.maxRetries,
      });
      return NextResponse.json(result);
    }

    if (action === "retry") {
      const result = await retryMaterialMetadataMigration(db, {
        actor: auth.actor,
        runId: payload.runId,
        batchSize: payload.batchSize,
        autoRollback: payload.autoRollback,
        force: payload.force === true,
        maxRetries: payload.maxRetries,
      });
      return NextResponse.json(result);
    }

    return NextResponse.json(
      {
        error: `Unsupported action "${action}". Expected "migrate", "rollback", or "retry".`,
        code: "VALIDATION_FIELD",
      },
      { status: 400 }
    );
  } catch (error) {
    if (!isAppError(error)) {
      console.error("POST /api/admin/migrations/material-metadata error:", error);
    }
    return mapAppError(error);
  }
}
