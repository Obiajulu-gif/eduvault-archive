export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { getUserFromCookie } from "@/lib/api/auth";
import { getExportDownload } from "@/lib/privacy/dataExportService";
import { auditLog } from "@/lib/api/audit";

/**
 * GET /api/privacy/export/download?requestId=...&token=...
 *
 * Returns the export manifest as a JSON file attachment.
 * The token is a 32-byte random secret embedded in the export record —
 * it acts as a capability so the user can share the link with a trusted
 * third party without exposing their session cookie.
 */
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "privacy_export_download", rateLimit: { limit: 10, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

      const { searchParams } = new URL(request.url);
      const requestId = searchParams.get("requestId");
      const token     = searchParams.get("token");
      if (!requestId || !token) {
        return NextResponse.json({ error: "Missing requestId or token" }, { status: 400 });
      }

      const userId = user.sub ?? user._id;

      try {
        const { manifest, expiresAt } = await getExportDownload(requestId, String(userId), token);

        auditLog({
          event:  "data_export_downloaded",
          actor:  String(userId),
          cursor: requestId,
          outcome: "success",
        });

        const json = JSON.stringify(manifest, null, 2);
        return new Response(json, {
          status: 200,
          headers: {
            "Content-Type":        "application/json",
            "Content-Disposition": `attachment; filename="eduvault-data-export-${requestId}.json"`,
            "Cache-Control":       "no-store",
            "Expires":             expiresAt ? new Date(expiresAt).toUTCString() : "0",
          },
        });
      } catch (err) {
        if (err.code === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 });
        if (err.code === "forbidden")  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        if (err.code === "expired")    return NextResponse.json({ error: "Export has expired" }, { status: 410 });
        if (err.code === "not_ready")  return NextResponse.json({ error: "Export not ready", status: err.status }, { status: 202 });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
