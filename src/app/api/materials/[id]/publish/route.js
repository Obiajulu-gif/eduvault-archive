export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { getUserFromCookie } from "@/lib/api/auth";
import { auditLog } from "@/lib/api/audit";
import {
  validatePublishRequest,
  getPublishingChecklist,
} from "@/lib/publishing/checklist";
import { pinMaterialMetadata } from "@/lib/ipfs/metadata";

/**
 * POST /api/materials/[id]/publish
 *
 * Publishes a material after verifying:
 *   1. The requester is authenticated.
 *   2. The requester owns the material.
 *   3. The material has all required fields populated (publishing checklist).
 */
export async function POST(request, { params }) {
  try {
    const materialId = params?.id;
    if (!materialId) {
      return NextResponse.json({ error: "Material not found" }, { status: 404 });
    }

    // ── Authenticate ──────────────────────────────────────────────────────
    const user = await getUserFromCookie(request);
    if (!user) {
      auditLog({ event: "publish_auth_failed", route: "material-publish", method: "POST", status: 401, materialId });
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const userAddress = user.walletAddress || user.address || user.id;
    if (!userAddress) {
      auditLog({ event: "publish_no_address", route: "material-publish", method: "POST", status: 400, actor: user.sub, materialId });
      return NextResponse.json({ error: "No wallet address on account" }, { status: 400 });
    }

    // ── Resolve material ──────────────────────────────────────────────────
    const db = await getDb();
    const material = await db.collection("materials").findOne({ _id: materialId });
    if (!material) {
      auditLog({ event: "publish_not_found", route: "material-publish", method: "POST", status: 404, materialId });
      return NextResponse.json({ error: "Material not found" }, { status: 404 });
    }

    // ── Validate publish readiness ────────────────────────────────────────
    const validation = validatePublishRequest(material, userAddress);
    if (!validation.valid) {
      auditLog({
        event: "publish_validation_failed",
        route: "material-publish",
        method: "POST",
        status: validation.status,
        actor: user.sub,
        materialId,
        reason: validation.error,
      });
      return NextResponse.json(
        {
          error: validation.error,
          checklist: validation.checklist,
        },
        { status: validation.status }
      );
    }

    if (validation.alreadyPublished) {
      auditLog({
        event: "publish_already_published",
        route: "material-publish",
        method: "POST",
        status: 200,
        actor: user.sub,
        materialId,
      });
      return NextResponse.json(
        {
          success: true,
          status: "published",
          alreadyPublished: true,
          checklist: validation.checklist,
        },
        { status: 200 }
      );
    }

    // ── Persist published status ──────────────────────────────────────────
    const body = await request.json().catch(() => ({}));
    const contractId = typeof body.contractId === "string" ? body.contractId.trim() : undefined;

    const updatePayload = {
      status: "published",
      publishedAt: new Date(),
      updatedAt: new Date(),
    };

    if (contractId) {
      updatePayload.contractId = contractId;
    }

    let metadataResult = null;
    try {
      metadataResult = await pinMaterialMetadata({ ...material, materialId });
      updatePayload.metadataCid = metadataResult.metadataCid;
      updatePayload.metadataUrl = metadataResult.metadataUrl;
    } catch (metadataErr) {
      auditLog({
        event: "publish_metadata_pin_failed",
        route: "material-publish",
        method: "POST",
        status: 502,
        actor: user.sub,
        materialId,
        reason: metadataErr.message,
      });
    }

    await db.collection("materials").updateOne(
      { _id: materialId },
      { $set: updatePayload }
    );

    auditLog({
      event: "publish_success",
      route: "material-publish",
      method: "POST",
      status: 200,
      actor: user.sub,
      materialId,
      metadataPinned: Boolean(metadataResult),
    });

    return NextResponse.json(
      {
        success: true,
        status: "published",
        checklist: validation.checklist,
        metadataUrl: metadataResult?.metadataUrl || null,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Publish error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

/**
 * GET /api/materials/[id]/publish
 *
 * Returns the publishing checklist for a material without publishing it.
 * Useful for the UI to show required/recommended fields before submission.
 */
export async function GET(request, { params }) {
  try {
    const materialId = params?.id;
    if (!materialId) {
      return NextResponse.json({ error: "Material not found" }, { status: 404 });
    }

    const user = await getUserFromCookie(request);
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const userAddress = user.walletAddress || user.address || user.id;
    if (!userAddress) {
      return NextResponse.json({ error: "No wallet address on account" }, { status: 400 });
    }

    const db = await getDb();
    const material = await db.collection("materials").findOne({ _id: materialId });

    // Return checklist even if material not found (shows all fields as missing)
    const checklist = getPublishingChecklist(material);

    // Ownership check for determining if user can publish
    const owner = material?.userAddress || material?.ownerAddress;
    const isOwner = material && owner && String(owner).toLowerCase() === String(userAddress).toLowerCase();

    return NextResponse.json({
      materialId,
      canPublish: isOwner && checklist.missingRequired.length === 0,
      isOwner,
      published: material?.status === "published" || false,
      checklist,
    });
  } catch (err) {
    console.error("Publish checklist error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
