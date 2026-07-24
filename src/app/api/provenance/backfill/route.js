export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { getUserFromCookie } from "@/lib/api/auth";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import { storeManifest, getLatestManifest, getVersionHistory } from "@/lib/provenance/registry";
import { hashFileBytes } from "@/lib/provenance/manifest";

export const runtime = "nodejs";

/**
 * POST /api/provenance/backfill
 *
 * Resumable legacy backfill endpoint. For existing materials that were created
 * before the provenance system, this generates manifests retroactively.
 * Materials with unverifiable states are surfaced rather than guessed.
 *
 * Body:
 *   - materialId: The material to backfill
 *   - dryRun: If true, reports what would be done without making changes
 *
 * Flow:
 *  1. Authenticate
 *  2. Fetch material record
 *  3. Check if manifest already exists
 *  4. Generate manifest from existing file metadata
 *  5. Handle unverifiable states (missing file, no hash, etc.)
 */

async function backfillMaterial({ materialId, dryRun = false }) {
  const db = await getDb();

  let material;
  try {
    material = await db.collection("materials").findOne({ materialId });
    if (!material && ObjectId.isValid(materialId)) {
      material = await db.collection("materials").findOne({ _id: new ObjectId(materialId) });
    }
  } catch (err) {
    return { success: false, error: "Material lookup failed", detail: err.message };
  }

  if (!material) {
    return { success: false, error: "Material not found" };
  }

  // Check if manifest already exists
  const existingManifest = await getLatestManifest(materialId);
  if (existingManifest) {
    return {
      success: true,
      skipped: true,
      reason: "Manifest already exists",
      existingVersion: existingManifest.version,
      digest: existingManifest.digest,
    };
  }

  // Resolve file reference
  const cid = material.ipfsCid || material.cid || material.fileHash || material.storageKey || material.fileUrl || "";
  if (!cid) {
    return {
      success: false,
      error: "unverifiable",
      detail: "Material has no file CID — cannot generate manifest without a file reference",
      materialId,
    };
  }

  // Resolve file hash — use existing if available, otherwise mark as unverifiable
  let fileHash = material.fileHash || null;
  if (!fileHash) {
    return {
      success: false,
      error: "unverifiable",
      detail: "Material has no file hash recorded — content integrity cannot be verified",
      materialId,
      cid,
      suggestion: "Re-upload the material through the upload endpoint to generate a proper manifest",
    };
  }

  // Resolve file size
  const fileSize = material.fileSize || material.size || null;
  if (fileSize == null) {
    return {
      success: false,
      error: "unverifiable",
      detail: "Material has no file size recorded",
      materialId,
      cid,
      fileHash,
    };
  }

  // Resolve file type
  const fileType = material.contentType || material.fileType || material.mimeType || null;
  if (!fileType) {
    return {
      success: false,
      error: "unverifiable",
      detail: "Material has no content type recorded",
      materialId,
      cid,
      fileHash,
      fileSize,
    };
  }

  // Build manifest
  const version = 1;
  const creator = material.userAddress || material.creatorAddress || null;

  const manifestData = {
    materialId,
    version,
    previousVersionDigest: null,
    creator: creator || "unknown",
    file: {
      cid,
      hash: fileHash,
      size: fileSize,
      type: fileType,
    },
    preview: (material.thumbnailUrl || material.coverImageUrl || material.image) ? {
      thumbnailCid: material.thumbnailCid || null,
      thumbnailHash: material.thumbnailHash || null,
      coverImageCid: material.coverImageCid || null,
      coverImageHash: material.coverImageHash || null,
    } : null,
    metadata: {
      title: material.title || null,
      description: material.description || null,
    },
    rights: material.usageRights ? {
      usageRights: material.usageRights,
    } : null,
  };

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      manifest: manifestData,
      detail: "Dry run — no changes made",
    };
  }

  try {
    const { manifest, digest } = await storeManifest(manifestData);

    return {
      success: true,
      materialId,
      version,
      digest,
      manifestStored: true,
    };
  } catch (err) {
    return {
      success: false,
      error: "Failed to store manifest",
      detail: err.message,
    };
  }
}

export async function POST(request) {
  return withApiHardening(
    request,
    { route: "provenance-backfill", rateLimit: { limit: 10, windowMs: 60_000 } },
    async () => {
      try {
        const user = await getUserFromCookie(request);
        if (!user) {
          auditLog({ event: "auth_failed", route: "provenance-backfill", method: "POST", status: 401 });
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await request.json();
        const { materialId, dryRun } = body || {};

        if (!materialId || typeof materialId !== "string") {
          return NextResponse.json({ error: "materialId is required" }, { status: 400 });
        }

        const result = await backfillMaterial({
          materialId,
          dryRun: Boolean(dryRun),
        });

        const status = result.success ? 200 : (result.error === "unverifiable" ? 422 : 404);
        auditLog({
          event: result.success ? "backfill_complete" : "backfill_failed",
          route: "provenance-backfill",
          method: "POST",
          status,
          materialId,
          actor: user.sub,
        });

        return NextResponse.json(result, { status });
      } catch (err) {
        console.error("[provenance-backfill] Error:", err);
        auditLog({
          event: "backfill_error",
          route: "provenance-backfill",
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
 * GET /api/provenance/backfill?materialId=xxx
 *
 * Check the backfill status for a material — shows whether a manifest exists
 * and whether it's verifiable.
 */
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "provenance-backfill", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      try {
        const user = await getUserFromCookie(request);
        if (!user) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { searchParams } = new URL(request.url);
        const materialId = searchParams.get("materialId");

        if (!materialId) {
          return NextResponse.json({ error: "materialId query param required" }, { status: 400 });
        }

        const db = await getDb();
        let material;
        try {
          material = await db.collection("materials").findOne({ materialId });
          if (!material && ObjectId.isValid(materialId)) {
            material = await db.collection("materials").findOne({ _id: new ObjectId(materialId) });
          }
        } catch (err) {
          return NextResponse.json({ error: "Material lookup failed" }, { status: 500 });
        }

        if (!material) {
          return NextResponse.json({ error: "Material not found" }, { status: 404 });
        }

        const manifests = await getVersionHistory(materialId);
        const latest = manifests.length > 0 ? manifests[manifests.length - 1] : null;

        const cid = material.ipfsCid || material.cid || material.fileHash || material.storageKey || material.fileUrl || "";
        const hasHash = Boolean(material.fileHash);
        const hasSize = material.fileSize != null || material.size != null;
        const hasType = Boolean(material.contentType || material.fileType || material.mimeType);

        return NextResponse.json({
          materialId,
          hasManifest: manifests.length > 0,
          manifestCount: manifests.length,
          latestVersion: latest?.version || null,
          latestDigest: latest?.digest || null,
          verifiable: Boolean(cid && hasHash && hasSize && hasType),
          missingFields: [
            !cid && "fileCid",
            !hasHash && "fileHash",
            !hasSize && "fileSize",
            !hasType && "contentType",
          ].filter(Boolean),
        });
      } catch (err) {
        console.error("[provenance-backfill] GET error:", err);
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
