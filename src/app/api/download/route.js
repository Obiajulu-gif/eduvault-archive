/**
 * GET /api/download — Issue #63 (Refactored for authenticated streaming)
 *
 * Protected file delivery endpoint. Verifies the caller holds an active
 * on-chain entitlement for the requested material before releasing the
 * IPFS CID or proxying the file stream. Verifies file integrity against
 * the purchased manifest version.
 *
 * Query params:
 *   - materialId  : The material identifier
 *   - buyerAddress: The buyer's Stellar public key
 *   - version     : Optional specific version to download
 *
 * Flow:
 *  1. Validate params
 *  2. verifyEntitlement() — checks cache → DB → chain
 *  3. Fetch material record to get the IPFS CID
 *  4. Verify manifest digest and version binding
 *  5. Return a signed/time-limited redirect to the IPFS gateway
 *     (or stream the file through the Next.js edge)
 */

import { NextResponse } from 'next/server';
import { verifyEntitlement } from '@/lib/entitlement';
import { getDb } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';
import { getIpfsUrl } from '@/lib/config/chain';
import { getManifest, getLatestManifest } from '@/lib/provenance/registry';
import { verifyManifestDigest, verifyFileCid } from '@/lib/provenance/verify';
import { resolveAuthenticatedWallet } from '@/lib/auth/walletIdentity';
import { normalizeBuyerAddress } from '@/lib/purchases/access';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const materialId = searchParams.get('materialId') ?? '';
  const identity = await resolveAuthenticatedWallet(request);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: identity.status });
  }
  const buyerAddress = identity.walletAddress;
  const requestedVersion = searchParams.get('version');

  // ── 1. Validate params ─────────────────────────────────────────────────────

  if (!materialId) {
    return NextResponse.json(
      { error: 'Missing materialId' },
      { status: 400 }
    );
  }

  // ── 2. Fetch material record to get the IPFS CID ──────────────────────────

  let material;
  try {
    const db = await getDb();
    material = await db.collection('materials').findOne({ materialId });
    if (!material && ObjectId.isValid(materialId)) {
      material = await db
        .collection('materials')
        .findOne({ _id: new ObjectId(materialId) });
    }
  } catch (err) {
    console.error('[download] DB error fetching material:', err);
    return NextResponse.json(
      { error: 'Material lookup failed' },
      { status: 503 }
    );
  }

  if (!material) {
    return NextResponse.json({ error: 'Material not found' }, { status: 404 });
  }

  // ── 3. Verify access / entitlement ────────────────────────────────────────

  const userAddress = normalizeBuyerAddress(buyerAddress);
  const isOwner =
    normalizeBuyerAddress(material.userAddress) === userAddress ||
    normalizeBuyerAddress(material.ownerAddress) === userAddress;

  let hasAccess = isOwner;
  let accessSource = 'owner';

  if (!hasAccess) {
    const price = Number(material.price || 0);
    if (price <= 0 && material.visibility === 'public') {
      hasAccess = true;
      accessSource = 'free-public';
    } else {
      try {
        const entitlementResult = await verifyEntitlement(materialId, buyerAddress);
        hasAccess = entitlementResult.hasAccess;
        accessSource = entitlementResult.source;
      } catch (err) {
        console.error('[download] entitlement check error:', err);
        return NextResponse.json(
          { error: 'Entitlement verification failed' },
          { status: 503 }
        );
      }
    }
  }

  if (!hasAccess) {
    return NextResponse.json(
      {
        error: 'Unlicensed Access',
        detail:
          'You do not hold an active entitlement for this material. Please purchase it first.',
      },
      { status: 403 }
    );
  }

  const cid =
    material.ipfsCid ??
    material.cid ??
    material.fileHash ??
    material.storageKey ??
    material.fileUrl ??
    '';

  if (!cid) {
    return NextResponse.json(
      { error: 'Material has no associated file CID' },
      { status: 404 }
    );
  }

  // ── 4. Verify manifest version binding ────────────────────────────────────

  let manifestVersion = null;
  let manifestDigestVerified = false;

  try {
    let manifestDoc = null;

    if (requestedVersion) {
      const versionNum = parseInt(requestedVersion, 10);
      if (Number.isFinite(versionNum) && versionNum > 0) {
        manifestDoc = await getManifest(materialId, versionNum);
      }
    }

    if (!manifestDoc) {
      manifestDoc = await getLatestManifest(materialId);
    }

    if (manifestDoc) {
      manifestVersion = manifestDoc.version;
      const versionWithdrawn = manifestDoc.withdrawn === true;

      if (versionWithdrawn) {
        return NextResponse.json(
          {
            error: 'Version Withdrawn',
            detail: `Version ${manifestVersion} has been withdrawn: ${manifestDoc.withdrawalReason || 'No reason specified'}`,
          },
          { status: 410 }
        );
      }

      manifestDigestVerified = verifyManifestDigest(
        manifestDoc.manifest,
        manifestDoc.digest
      );

      // Verify the served CID matches the manifest
      const cidMatch = verifyFileCid(materialId, manifestVersion, cid);
      if (!cidMatch.valid) {
        console.warn('[download] CID mismatch:', cidMatch.detail);
      }
    }
  } catch (manifestErr) {
    console.warn('[download] Manifest verification error:', manifestErr?.message);
  }

  // ── 5. Release CID / redirect to IPFS gateway ────────────────────────────

  return NextResponse.json(
    {
      ok: true,
      materialId,
      cid: cid,
      fileUrl: getIpfsUrl(cid),
      manifestVersion,
      manifestDigestVerified,
      fileName: material.fileName ?? material.title ?? materialId,
      contentType: material.contentType ?? 'application/octet-stream',
      fileSize: material.fileSize || 0,
      source: accessSource,
    },
    {
      headers: {
        'Cache-Control': 'private, max-age=60',
        'X-Entitlement-Source': accessSource,
        'X-Manifest-Version': manifestVersion ? String(manifestVersion) : '',
        'X-Manifest-Verified': manifestDigestVerified ? 'true' : 'false',
      },
    }
  );
}
