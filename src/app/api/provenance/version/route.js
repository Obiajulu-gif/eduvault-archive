export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { getUserFromCookie } from "@/lib/api/auth";
import { getDb } from "@/lib/mongodb";
import {
  storeManifest,
  getLatestManifest,
  getVersionHistory,
  withdrawManifest,
  verifyVersionChain,
} from "@/lib/provenance/registry";

/**
 * POST /api/provenance/version
 *
 * Publish a new version of a material. Creates a chained manifest
 * where each version's previousVersionDigest links to the prior version's digest.
 *
 * Body:
 *   - materialId: The material identifier
 *   - file: { cid, hash, size, type }
 *   - preview: { thumbnailCid, thumbnailHash } (optional)
 *   - metadata: { title, description, ... } (optional)
 *   - rights: { usageRights } (optional)
 */

async function publishNewVersion({ materialId, file, preview, metadata, rights }) {
  const db = await getDb();

  // Verify material exists and caller is the owner
  const material = await db.collection("materials").findOne({ materialId });
  if (!material) {
    return { success: false, error: "Material not found", status: 404 };
  }

  // Get latest version for chaining
  const latestManifest = await getLatestManifest(materialId);
  const nextVersion = latestManifest ? latestManifest.version + 1 : 1;
  const previousDigest = latestManifest ? latestManifest.digest : null;

  const creator = material.userAddress || material.creatorAddress || null;

  const { manifest, digest } = await storeManifest({
    materialId,
    version: nextVersion,
    previousVersionDigest: previousDigest,
    creator,
    file,
    preview,
    metadata,
    rights,
  });

  return {
    success: true,
    materialId,
    version: nextVersion,
    digest,
    previousVersionDigest: previousDigest,
  };
}

/**
 * POST /api/provenance/version (with action=withdraw)
 *
 * Withdraw a material version.
 *
 * Body:
 *   - materialId: The material identifier
 *   - version: The version to withdraw
 *   - reason: Withdrawal reason
 */

async function withdrawVersion({ materialId, version, reason }) {
  const user = await getUserFromCookie(null);
  await withdrawManifest(materialId, version, reason, user?.sub || "unknown");

  return {
    success: true,
    materialId,
    version,
    withdrawn: true,
    reason,
  };
}

export async function POST(request) {
  return withApiHardening(
    request,
    { route: "provenance-version", rateLimit: { limit: 20, windowMs: 60_000 } },
    async () => {
      try {
        const user = await getUserFromCookie(request);
        if (!user) {
          auditLog({ event: "auth_failed", route: "provenance-version", method: "POST", status: 401 });
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await request.json();
        const { action, materialId, file, preview, metadata, rights, version, reason } = body || {};

        if (!materialId || typeof materialId !== "string") {
          return NextResponse.json({ error: "materialId is required" }, { status: 400 });
        }

        let result;
        if (action === "withdraw") {
          if (!version) {
            return NextResponse.json({ error: "version is required for withdraw action" }, { status: 400 });
          }
          result = await withdrawVersion({
            materialId,
            version: Number(version),
            reason: reason || "Not specified",
          });
        } else {
          if (!file || !file.cid || !file.hash || file.size == null || !file.type) {
            return NextResponse.json({
              error: "file is required with cid, hash, size, and type",
            }, { status: 400 });
          }
          result = await publishNewVersion({ materialId, file, preview, metadata, rights });
        }

        const status = result.success ? 201 : (result.status || 500);
        auditLog({
          event: result.success ? "version_published" : "version_publish_failed",
          route: "provenance-version",
          method: "POST",
          status,
          materialId,
          actor: user.sub,
        });

        return NextResponse.json(result, { status });
      } catch (err) {
        console.error("[provenance-version] Error:", err);
        auditLog({
          event: "version_error",
          route: "provenance-version",
          method: "POST",
          status: 500,
          reason: err.message,
        });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}

/**
 * GET /api/provenance/version?materialId=xxx&version=N
 *
 * Retrieve version information for a material.
 */
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "provenance-version", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      try {
        const { searchParams } = new URL(request.url);
        const materialId = searchParams.get("materialId");
        const version = searchParams.get("version");

        if (!materialId) {
          return NextResponse.json({ error: "materialId query param required" }, { status: 400 });
        }

        if (version) {
          const versionNum = parseInt(version, 10);
          if (!Number.isFinite(versionNum) || versionNum < 1) {
            return NextResponse.json({ error: "Invalid version number" }, { status: 400 });
          }

          const { getManifest } = await import("@/lib/provenance/registry");
          const manifest = await getManifest(materialId, versionNum);
          if (!manifest) {
            return NextResponse.json({ error: "Version not found" }, { status: 404 });
          }
          return NextResponse.json(manifest);
        }

        const chain = await verifyVersionChain(materialId);
        const latest = await getLatestManifest(materialId);

        return NextResponse.json({
          materialId,
          latestVersion: latest?.version || null,
          latestDigest: latest?.digest || null,
          chainValid: chain.valid,
          brokenAt: chain.brokenAt,
          versionCount: chain.manifests.length,
          versions: chain.manifests.map((m) => ({
            version: m.version,
            digest: m.digest,
            withdrawn: m.withdrawn || false,
            createdAt: m.createdAt,
          })),
        });
      } catch (err) {
        console.error("[provenance-version] GET error:", err);
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
