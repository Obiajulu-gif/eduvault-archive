export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { getUserFromCookie } from "@/lib/api/auth";
import { auditLog } from "@/lib/api/audit";
import {
  createExportRequest,
  generateExport,
  getExportStatus,
  EXPORT_STATUS,
} from "@/lib/privacy/dataExportService";

/**
 * POST /api/privacy/export
 * Initiate a data export for the authenticated user.
 * Runs generation inline for simplicity; large accounts should move this to an outbox job.
 */
export async function POST(request) {
  return withApiHardening(
    request,
    { route: "privacy_export", rateLimit: { limit: 3, windowMs: 60 * 60 * 1000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const userId = user.sub ?? user._id;

      try {
        const { alreadyExists, request: exportReq } = await createExportRequest(userId);

        if (alreadyExists) {
          return NextResponse.json({
            requestId: String(exportReq._id),
            status: exportReq.status,
            message: "An export is already in progress or ready for download.",
          }, { status: 200 });
        }

        // Kick off generation synchronously (suitable for most accounts).
        // For very large accounts this can be moved to an outbox event.
        await generateExport(String(exportReq._id));

        const status = await getExportStatus(String(exportReq._id), String(userId));

        auditLog({
          event: "data_export_requested",
          actor: String(userId),
          outcome: "success",
        });

        return NextResponse.json({
          requestId: String(exportReq._id),
          token: exportReq.token,
          ...status,
        }, { status: 202 });
      } catch (err) {
        auditLog({
          event: "data_export_failed",
          actor: String(userId),
          reason: err.message,
        });
        return NextResponse.json({ error: "Export failed" }, { status: 500 });
      }
    }
  );
}

/**
 * GET /api/privacy/export?requestId=...
 * Poll the status of a pending export.
 */
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "privacy_export_status", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

      const { searchParams } = new URL(request.url);
      const requestId = searchParams.get("requestId");
      if (!requestId) return NextResponse.json({ error: "Missing requestId" }, { status: 400 });

      const userId = user.sub ?? user._id;

      try {
        const status = await getExportStatus(requestId, String(userId));
        return NextResponse.json(status);
      } catch (err) {
        if (err.code === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 });
        if (err.code === "forbidden")  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
