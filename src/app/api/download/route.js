/**
 * GET /api/download — Issue #63
 *
 * Protected file delivery endpoint. Verifies the caller holds an active
 * on-chain entitlement for the requested material before releasing the
 * IPFS CID or proxying the file stream.
 *
 * Query params:
 *   - materialId  : The material identifier
 *   - buyerAddress: The buyer's Stellar public key
 *
 * Flow:
 *  1. Validate params
 *  2. verifyEntitlement() — checks cache → DB → chain
 *  3. Fetch material record to get the IPFS CID
 *  4. Return a signed/time-limited redirect to the IPFS gateway
 *     (or stream the file through the Next.js edge)
 */

import { NextResponse } from 'next/server';
import { verifyEntitlement } from '@/lib/entitlement';
import { getDb } from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

const IPFS_GATEWAY = process.env.IPFS_GATEWAY_URL ?? 'https://ipfs.io/ipfs';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const materialId = searchParams.get('materialId') ?? '';
  const buyerAddress = searchParams.get('buyerAddress') ?? '';

  // ── 1. Validate params ─────────────────────────────────────────────────────

  if (!materialId || !buyerAddress) {
    return NextResponse.json(
      { error: 'Missing materialId or buyerAddress' },
      { status: 400 }
    );
  }

  // ── 2. Verify entitlement ─────────────────────────────────────────────────

  let entitlementResult;
  try {
    entitlementResult = await verifyEntitlement(materialId, buyerAddress);
  } catch (err) {
    console.error('[download] entitlement check error:', err);
    return NextResponse.json(
      { error: 'Entitlement verification failed' },
      { status: 503 }
    );
  }

  if (!entitlementResult.hasAccess) {
    return NextResponse.json(
      {
        error: 'Unlicensed Access',
        detail:
          'You do not hold an active entitlement for this material. Purchase it first.',
      },
      { status: 403 }
    );
  }

  // ── 3. Fetch material record to get CID ──────────────────────────────────

  let material;
  try {
    const db = await getDb();
    material = await db.collection('materials').findOne({ materialId });
  } catch (err) {
    console.error('[download] DB error fetching material:', err);
    return NextResponse.json({ error: 'Material lookup failed' }, { status: 503 });
  }

  if (!material) {
    return NextResponse.json({ error: 'Material not found' }, { status: 404 });
  }

  const cid = material.ipfsCid ?? material.cid ?? material.fileHash ?? '';

  if (!cid) {
    return NextResponse.json(
      { error: 'Material has no associated file CID' },
      { status: 404 }
    );
  }

  // ── 4. Release CID / redirect to IPFS gateway ────────────────────────────

  // Option A — return the CID to the client so it can fetch directly.
  //   This keeps the server stateless but exposes the CID.
  // Option B — proxy the file through the server (larger response, more privacy).
  //
  // We use Option A here: return the resolved URL. Switch to Option B if CIDs
  // must stay private (requires streaming the IPFS response through fetch).

  const fileUrl = `${IPFS_GATEWAY}/${cid}`;

  return NextResponse.json(
    {
      ok: true,
      materialId,
      fileUrl,
      fileName: material.fileName ?? material.title ?? materialId,
      contentType: material.contentType ?? 'application/octet-stream',
      source: entitlementResult.source,
    },
    {
      headers: {
        // Short-lived cache — allow the same buyer to hit the edge again quickly
        'Cache-Control': 'private, max-age=60',
        'X-Entitlement-Source': entitlementResult.source,
      },
    }
  );
}
