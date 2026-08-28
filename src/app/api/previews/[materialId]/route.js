/**
 * Preview descriptor serving route (#638).
 *
 * A separate trust domain from the original file: it serves ONLY the validated
 * JSON descriptor produced by the sandbox, under a locked-down header set, and
 * ONLY when the preview state is `ready`. It never returns, links to, or
 * unlocks the original file — a missing or failed preview is a 404/425, not a
 * fallback.
 *
 * Time/space: O(1) — one indexed material lookup + one indexed preview lookup.
 */

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { COLLECTIONS } from "@/lib/backend/schemaContracts";
import { getPreview, PREVIEW_STATES } from "@/lib/backend/previewStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Locked-down policy for a payload derived from an attacker-controlled file.
const PREVIEW_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Content-Disposition": "inline",
};

function json(body, status, extraHeaders = {}) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { ...PREVIEW_HEADERS, ...extraHeaders },
  });
}

export async function GET(request, { params }) {
  return withApiHardening(
    request,
    { route: "preview_descriptor", rateLimit: { limit: 120, windowMs: 60_000 } },
    async () => {
      const materialId = (await params).materialId;
      const db = await getDb();

      const query = { isDeleted: { $ne: true } };
      try {
        query._id = new ObjectId(materialId);
      } catch {
        query._id = undefined;
        query.materialId = materialId;
      }

      const material = await db.collection(COLLECTIONS.materials).findOne(query, {
        projection: { storageKey: 1, visibility: 1 },
      });
      if (!material || !material.storageKey) {
        return json({ error: "not found" }, 404);
      }

      const preview = await getPreview(db, material.storageKey);
      if (!preview) {
        return json({ state: "pending", error: "preview not generated yet" }, 425);
      }
      if (preview.state !== PREVIEW_STATES.READY || !preview.descriptor) {
        return json({ state: preview.state, error: "preview unavailable" }, preview.state === PREVIEW_STATES.PENDING ? 425 : 404);
      }

      return json(
        {
          state: "ready",
          previewerVersion: preview.previewerVersion || null,
          generatedAt: preview.generatedAt || preview.updatedAt || null,
          descriptor: preview.descriptor,
        },
        200,
        { "Cache-Control": "public, max-age=86400, immutable" },
      );
    },
  );
}
