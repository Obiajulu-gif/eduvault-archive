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
 *  2. authorizeMaterialAccess() — the single entitlement policy boundary
 *  3. Fetch material record to get the IPFS CID
 *  4. Return a signed/time-limited redirect to the IPFS gateway
 *     (or stream the file through the Next.js edge)
 */

import { NextResponse } from 'next/server';
import { authorizeMaterialAccess } from '@/lib/entitlement';
import { getDb } from '@/lib/mongodb';
import { getIpfsUrl } from '@/lib/config/chain';
import { ObjectId } from 'mongodb';
import { getUserFromCookie } from '@/lib/api/auth';
import { normalizeBuyerAddress } from '@/lib/purchases/access';


export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const materialId = searchParams.get('materialId') ?? '';
  const buyerAddressParam = searchParams.get('buyerAddress') ?? '';

  // ── 1. Validate params ─────────────────────────────────────────────────────

  if (!materialId) {
    return NextResponse.json(
      { error: 'Missing materialId' },
      { status: 400 }
    );
  }

  // ── 2. Authenticate user from session cookie ────────────────────────────────

  const user = await getUserFromCookie(request);
  if (!user) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const userAddress = normalizeBuyerAddress(user.walletAddress || user.address || user.id);
  if (!userAddress) {
    return NextResponse.json({ error: 'No wallet address on account' }, { status: 400 });
  }

  if (buyerAddressParam && buyerAddressParam.toLowerCase() !== userAddress.toLowerCase()) {
    return NextResponse.json({ error: 'Forbidden: Cannot request downloads for other accounts' }, { status: 403 });
  }

  const buyerAddress = buyerAddressParam || userAddress;

  // ── 3. Fetch material record to get CID ──────────────────────────────────

  let db;
  let material;
  try {
    db = await getDb();
    material = await db.collection('materials').findOne({ materialId });
    if (!material && ObjectId.isValid(materialId)) {
      material = await db.collection('materials').findOne({ _id: new ObjectId(materialId) });
    }
  } catch (err) {
    console.error('[download] DB error fetching material:', err);
    return NextResponse.json({ error: 'Material lookup failed' }, { status: 503 });
  }

  if (!material) {
    return NextResponse.json({ error: 'Material not found' }, { status: 404 });
  }

  // ── 4. Verify access via the single entitlement policy boundary ─────────────

  const decision = await authorizeMaterialAccess({ db, material, buyerAddress });

  if (!decision.allowed) {
    return NextResponse.json(
      {
        error: decision.state === 'unavailable' ? 'Entitlement verification unavailable' : 'Unlicensed Access',
        detail:
          decision.state === 'unavailable'
            ? 'Could not confirm your entitlement right now. Please try again shortly.'
            : 'You do not hold an active entitlement for this material. Please purchase it first.',
      },
      { status: decision.httpStatus }
    );
  }

  const accessSource = decision.source;

  const cid = material.ipfsCid ?? material.cid ?? material.fileHash ?? material.storageKey ?? material.fileUrl ?? '';

  if (!cid) {
    return NextResponse.json(
      { error: 'Material has no associated file CID' },
      { status: 404 }
    );
  }

  // ── 5. Release CID / redirect to IPFS gateway ────────────────────────────

  const fileUrl = getIpfsUrl(cid);

  return NextResponse.json(
    {
      ok: true,
      materialId,
      fileUrl,
      fileName: material.fileName ?? material.title ?? materialId,
      contentType: material.contentType ?? 'application/octet-stream',
      source: accessSource,
    },
    {
      headers: {
        'Cache-Control': 'private, max-age=60',
        'X-Entitlement-Source': accessSource,
      },
    }
  );
}
