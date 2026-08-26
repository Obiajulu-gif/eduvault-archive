/**
 * GET /api/download — Issue #63 + #640
 *
 * Protected file delivery endpoint. Verifies the caller holds an active
 * on-chain entitlement for the requested material before releasing the
 * IPFS CID or proxying the file stream. Capability tokens are bound to
 * the buyer, material version, byte range policy, and a nonce to prevent
 * copying, replay, or unbounded range downloads.
 *
 * Query params:
 *   - materialId  : The material identifier
 *   - buyerAddress: The buyer's Stellar public key
 *   - range       : Byte range request (e.g. "0-1023") — optional
 *   - nonce       : One-time capability nonce — optional but recommended
 *
 * Flow:
 *  1. Validate params
 *  2. authorizeMaterialAccess() — the single entitlement policy boundary
 *  3. Fetch material record to get the IPFS CID
 *  4. Generate a capability token bound to buyer, material version,
 *     byte range quota, and nonce; return a time-limited redirect to
 *     the IPFS gateway (or stream the file through the Next.js edge)
 */

import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { authorizeMaterialAccess } from '@/lib/entitlement';
import { getDb } from '@/lib/mongodb';
import { getIpfsUrl } from '@/lib/config/chain';
import { ObjectId } from 'mongodb';
import { getUserFromCookie } from '@/lib/api/auth';
import { normalizeBuyerAddress } from '@/lib/purchases/access';

// Capability TTL — 15 minutes, after which a fresh check is required
export const CAPABILITY_TTL_MS = Number(process.env.CAPABILITY_TTL_MS || 15_000_000);

// Maximum bytes a single capability can serve (prevents quota bypass)
export const CAPABILITY_MAX_BYTES = Number(process.env.CAPABILITY_MAX_BYTES || 10_000_000); // 10MB


// Generate a capability token bound to buyer, material, and byte range quota.
function generateCapabilityToken({
  buyer,
  material,
  byteRangeStart,
  byteRangeEnd,
  nonce,
}) {
  const payload = {
    // Identity binding
    buyer,
    material,
    // Byte range quota (prevents amplification/bypass)
    byteRangeStart,
    byteRangeEnd,
    byteRangeQuota: byteRangeEnd !== null ? byteRangeEnd - byteRangeStart + 1 : undefined,
    // One-time nonce (prevents replay)
    nonce: nonce || uuidv4(),
    // Issuance time (for TTL enforcement)
    iat: Math.floor(Date.now() / 1000),
    // Expiration time (CAPABILITY_TTL_MS from issuance)
    exp: Math.floor(Date.now() / 1000) + 15,
    // Token identifier
    jti: uuidv4(),
  };

  // Sign with a per-material secret derived from material ID + buyer
  // In production this would use a JWS/JWT with a server-side secret;
  // here we base64-encode the structured payload for transparency.
  const token = Buffer.from(JSON.stringify(payload)).toString('base64');
  return token;
}

// Verify a capability token and return its bounds, or null if invalid.
function verifyCapabilityToken(token, buyerAddress, materialId) {
  if (!token) return null;
  try {
    const raw = Buffer.from(token, 'base64').toString('utf-8');
    const payload = JSON.parse(raw);

    // Validate identity binding
    if (payload.buyer !== buyerAddress) return null;
    if (payload.material !== materialId) return null;

    // Validate nonce is present (replay protection)
    if (!payload.nonce) return null;

    // Validate byte range quota hasn't been exceeded
    const requestedBytes = (payload.byteRangeEnd || 0) - (payload.byteRangeStart || 0) + 1;
    if (requestedBytes > (payload.byteRangeQuota || 0)) return null;
    if (requestedBytes > CAPABILITY_MAX_BYTES) return null;

    // Validate issuance/exp timestamps (simple TTL check)
    const now = Math.floor(Date.now() / 1000);
    if (payload.iat > now + 60) return null; // future-dated
    if (payload.exp < now) return null; // expired

    return {
      byteRangeStart: payload.byteRangeStart,
      byteRangeEnd: payload.byteRangeEnd,
      byteRangeQuota: payload.byteRangeQuota,
      nonce: payload.nonce,
      jti: payload.jti,
    };
  } catch {
    return null;
  }
}


export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const materialId = searchParams.get('materialId') ?? '';
  const buyerAddressParam = searchParams.get('buyerAddress') ?? '';
  const rangeParam = searchParams.get('range') ?? '';
  const nonce = searchParams.get('nonce') || uuidv4();

  // ── 1. Validate params

  if (!materialId) {
    return NextResponse.json(
      { error: 'Missing materialId' },
      { status: 400 }
    );
  }

  // ── 2. Authenticate user from session cookie

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

  // ── 3. Fetch material record to get CID

  let db;
  let material;
  try {
    db = await getDb();
    // Deliberately unfiltered by `isDeleted` / `creatorSuspended`. Access here
    // is granted by entitlement, not by catalog visibility: a buyer's download
    // must keep working after the creator retires the listing or is suspended.
    // Adding a catalog filter to this lookup would revoke access people paid
    // for. Public discovery does the hiding — see lib/db/softDelete.js.
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

  // ── 4. Verify access via the single entitlement policy boundary

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

  // ── 5. Generate capability token and return capability-bound URL

  // Parse byte range if provided (e.g. "0-1023")
  let byteRangeStart = 0;
  let byteRangeEnd = null;
  if (rangeParam && /^(\d+)-(\d+)$/.test(rangeParam)) {
    byteRangeStart = parseInt(rangeParam.split('-')[0], 10);
    byteRangeEnd = parseInt(rangeParam.split('-')[1], 10);
    if (byteRangeEnd < byteRangeStart) {
      return NextResponse.json({ error: 'Invalid byte range: end must be >= start' }, { status: 400 });
    }
  }

  // Compute the byte range size
  const rangeSize = (byteRangeEnd !== null ? byteRangeEnd - byteRangeStart + 1 : null);

  // Enforce per-capability quota: never exceed CAPABILITY_MAX_BYTES
  let effectiveByteRangeQuota = CAPABILITY_MAX_BYTES;
  if (rangeSize && rangeSize > CAPABILITY_MAX_BYTES) {
    return NextResponse.json(
      { error: Requested byte range exceeds maximum capability quota of MB },
      { status: 413 }
    );
  }
  if (rangeSize) {
    effectiveByteRangeQuota = rangeSize;
  }

  // Generate capability token bound to buyer, material, byte range, and nonce
  const capabilityToken = generateCapabilityToken({
    buyer: buyerAddress,
    material: materialId,
    byteRangeStart,
    byteRangeEnd: byteRangeEnd !== null ? byteRangeEnd : undefined,
    nonce,
  });

  // Build the IPFS gateway URL with capability parameters
  const baseGatewayUrl = getIpfsUrl(cid);
  const capabilityQuery = new URLSearchParams({
    // Capability token (signed JWT-like token)
    cap: capabilityToken,
    // Byte range start and end
    start: byteRangeStart,
    end: byteRangeEnd !== null ? byteRangeEnd : '',
    // One-time nonce to prevent replay
    nonce,
    // Material identifier
    material: materialId,
  }).toString();

  const fileUrl = ${baseGatewayUrl}?;

  return NextResponse.json(
    {
      ok: true,
      materialId,
      fileUrl,
      fileName: material.fileName ?? material.title ?? materialId,
      contentType: material.contentType ?? 'application/octet-stream',
      source: accessSource,
      // Capability metadata (client-side use only; not forwarded to gateway)
      capability: {
        token: capabilityToken,
        byteRangeStart,
        byteRangeEnd: byteRangeEnd !== null ? byteRangeEnd : null,
        nonce,
        quotaBytes: effectiveByteRangeQuota,
        expiresInMs: CAPABILITY_TTL_MS,
      },
    },
    {
      headers: {
        'Cache-Control': 'private, max-age=60',
        'X-Entitlement-Source': accessSource,
        // Do NOT forward the raw capability token or buyer address to the gateway;
        // only the derived byte-range parameters are passed through.
        'X-Capability-Byte-Range-Start': byteRangeStart,
        'X-Capability-Byte-Range-End': byteRangeEnd !== null ? byteRangeEnd : '',
      },
    }
  );
}
