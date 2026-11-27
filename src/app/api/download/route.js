/**
 * GET /api/download — Issue #63 + #640 + #675
 *
 * Protected file delivery endpoint. Verifies the caller holds an active
 * on-chain entitlement for the requested material before releasing a
 * short-lived, HMAC-signed capability URL for the IPFS gateway. Capability
 * tokens are bound to the buyer, material, byte range policy, and a nonce
 * to prevent copying, replay, or unbounded range downloads (#640) — and
 * are now cryptographically signed rather than plain base64(JSON) (#675),
 * so a client can no longer tamper with the byte range, buyer, or expiry
 * fields undetected. Every issuance and denial is written to a persisted,
 * audit-safe access log (lib/downloads/accessLog.js) — never containing
 * the raw token or the signed URL itself.
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
 *  4. Generate a signed capability token bound to buyer, material, byte
 *     range quota, and nonce; return a time-limited capability URL for the
 *     IPFS gateway
 *  5. Record the issuance (or denial) in the persisted access log
 */

import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { authorizeMaterialAccess } from '@/lib/entitlement';
import { getDb } from '@/lib/mongodb';
import { getPinningProviders } from '@/lib/pinata';
import { resolveFromGateways } from '@/lib/storage/pinningService';
import { ObjectId } from 'mongodb';
import { getUserFromCookie } from '@/lib/api/auth';
import { normalizeBuyerAddress } from '@/lib/purchases/access';
import {
  generateCapabilityToken,
  verifyCapabilityToken,
  CAPABILITY_TTL_MS,
  CAPABILITY_MIN_TTL_MS,
  CAPABILITY_MAX_TTL_MS,
  CAPABILITY_MAX_BYTES,
} from '@/lib/downloads/capabilityToken';
import { parseByteRangeParam, validateExpiryLimit } from '@/lib/downloads/signedDownloadAuth';
import { recordDownloadAccess } from '@/lib/downloads/accessLog';
import { buildAnalyticsEvent, enqueueAnalyticsEvent } from '@/lib/backend/analyticsEvents';
import { withTelemetryRoute, ACTOR_TYPES } from '@/lib/monitoring/telemetry';
import { renderProblemResponse } from '@/lib/errors/renderErrorResponse.js';
import { AppError } from '@/lib/errors/AppError.js';
import { withApiErrorHandling } from '@/lib/api/hardening';
import { captureException } from '@/lib/sentry';

export { CAPABILITY_TTL_MS, CAPABILITY_MAX_BYTES };

export const dynamic = 'force-dynamic';

function clientIpFrom(request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || null;
}

async function handleGet(request) {
  const { searchParams } = new URL(request.url);
  const materialId = searchParams.get('materialId') ?? '';
  const buyerAddressParam = searchParams.get('buyerAddress') ?? '';
  const rangeParam = searchParams.get('range') ?? '';
  const nonce = searchParams.get('nonce') || uuidv4();
  const ipAddress = clientIpFrom(request);

  // ── 1. Validate params

  if (!materialId) {
    return renderProblemResponse("VALIDATION_FIELD", request, "Missing materialId");
  }

  // ── 2. Authenticate user from session cookie

  const user = await getUserFromCookie(request);
  if (!user) {
    return renderProblemResponse("AUTH_UNAUTHENTICATED", request, "Authentication required");
  }

  const userAddress = normalizeBuyerAddress(user.walletAddress || user.address || user.id);
  if (!userAddress) {
    return renderProblemResponse("VALIDATION_FIELD", request, "No wallet address on account");
  }

  if (buyerAddressParam && buyerAddressParam.toLowerCase() !== userAddress.toLowerCase()) {
    return renderProblemResponse("AUTH_FORBIDDEN", request, "Forbidden: Cannot request downloads for other accounts");
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
    captureException(err, { route: "material-download", method: "GET" });
    return renderProblemResponse("ENTITLEMENT_UNAVAILABLE", request, "Material lookup failed");
  }

  if (!material) {
    return renderProblemResponse("NOT_FOUND", request, "Material not found");
  }

  // ── 4. Verify access via the single entitlement policy boundary

  let decision;
  try {
    decision = await authorizeMaterialAccess({ db, material, buyerAddress });
  } catch (error) {
    throw new AppError("ENTITLEMENT_UNAVAILABLE", { cause: error });
  }

  if (!decision.allowed) {
    await recordDownloadAccess(db, {
      event: 'access_denied',
      materialId,
      buyerAddress,
      denialReason: decision.state,
      ipAddress,
    });

    const code = decision.state === 'unavailable'
      ? "ENTITLEMENT_UNAVAILABLE"
      : decision.httpStatus === 402
        ? "ENTITLEMENT_PURCHASE_REQUIRED"
        : "ENTITLEMENT_REQUIRED";
    return renderProblemResponse(
      code,
      request,
      decision.state === 'unavailable'
        ? "Entitlement verification unavailable"
        : "Unlicensed Access"
    );
  }

  const accessSource = decision.source;

  const cid = material.ipfsCid ?? material.cid ?? material.fileHash ?? material.storageKey ?? material.fileUrl ?? '';

  if (!cid) {
    return renderProblemResponse("STORAGE_NOT_FOUND", request, "Material has no associated file CID");
  }

  // ── 5. Generate a signed capability token and return the capability URL

  // Parse and strictly validate byte range if provided (e.g. "0-1023")
  const parsedRange = parseByteRangeParam(rangeParam);
  if (!parsedRange.ok) {
    return renderProblemResponse("VALIDATION_FIELD", request, parsedRange.message);
  }
  const { byteRangeStart, byteRangeEnd, rangeSize } = parsedRange;

  // Validate optional maxBytes override
  const maxBytesParam = searchParams.get('maxBytes');
  let requestedMaxBytes = null;
  if (maxBytesParam !== null && maxBytesParam !== '') {
    requestedMaxBytes = Number.parseInt(maxBytesParam, 10);
    if (!Number.isSafeInteger(requestedMaxBytes) || requestedMaxBytes <= 0) {
      return renderProblemResponse("VALIDATION_FIELD", request, "Invalid maxBytes: must be a positive integer");
    }
    if (requestedMaxBytes > CAPABILITY_MAX_BYTES) {
      return renderProblemResponse(
        "VALIDATION_RANGE_TOO_LARGE",
        request,
        `Requested maxBytes exceeds maximum capability quota of ${CAPABILITY_MAX_BYTES / 1_000_000}MB`
      );
    }
  }

  // Validate optional expiresInMs override within [CAPABILITY_MIN_TTL_MS, CAPABILITY_MAX_TTL_MS]
  const expiresInMsParam = searchParams.get('expiresInMs');
  const ttlCheck = validateExpiryLimit(
    expiresInMsParam !== null && expiresInMsParam !== '' ? Number(expiresInMsParam) : undefined,
    {
      defaultTtlMs: CAPABILITY_TTL_MS,
      minTtlMs: CAPABILITY_MIN_TTL_MS,
      maxTtlMs: CAPABILITY_MAX_TTL_MS,
    }
  );
  if (!ttlCheck.ok) {
    return renderProblemResponse(
      "VALIDATION_FIELD",
      request,
      `Invalid expiresInMs: must be between ${CAPABILITY_MIN_TTL_MS}ms and ${CAPABILITY_MAX_TTL_MS}ms`
    );
  }
  const effectiveTtlMs = ttlCheck.ttlMs;

  // Enforce per-capability quota: never exceed CAPABILITY_MAX_BYTES
  let effectiveByteRangeQuota = requestedMaxBytes ?? CAPABILITY_MAX_BYTES;
  if (rangeSize && rangeSize > CAPABILITY_MAX_BYTES) {
    return renderProblemResponse(
      "VALIDATION_RANGE_TOO_LARGE",
      request,
      `Requested byte range exceeds maximum capability quota of ${CAPABILITY_MAX_BYTES / 1_000_000}MB`
    );
  }
  if (rangeSize && rangeSize > effectiveByteRangeQuota) {
    return renderProblemResponse(
      "VALIDATION_RANGE_TOO_LARGE",
      request,
      "Requested byte range exceeds requested maxBytes limit"
    );
  }
  if (rangeSize) {
    effectiveByteRangeQuota = rangeSize;
  }

  // Generate a signed capability token bound to buyer, material, byte
  // range, byte limit, expiry limit, and nonce (#675).
  const { token: capabilityToken, payload: capabilityPayload } = generateCapabilityToken({
    buyer: buyerAddress,
    material: materialId,
    byteRangeStart,
    byteRangeEnd: byteRangeEnd !== null ? byteRangeEnd : undefined,
    maxBytes: effectiveByteRangeQuota,
    ttlMs: effectiveTtlMs,
    nonce,
  });

  // Build the IPFS gateway URL with capability parameters
  let baseGatewayUrl;
  try {
    baseGatewayUrl = /^https?:\/\//.test(cid)
      ? cid
      : (await resolveFromGateways(cid, getPinningProviders())).url;
  } catch (error) {
    throw new AppError("STORAGE_UNAVAILABLE", { cause: error });
  }
  const capabilityQuery = new URLSearchParams({
    // Signed capability token
    cap: capabilityToken,
    // Byte range start and end
    start: String(byteRangeStart),
    end: byteRangeEnd !== null ? String(byteRangeEnd) : '',
    // One-time nonce to prevent replay
    nonce,
    // Material identifier
    material: materialId,
  }).toString();

  const fileUrl = `${baseGatewayUrl}?${capabilityQuery}`;

  await recordDownloadAccess(db, {
    event: 'capability_issued',
    materialId,
    buyerAddress,
    decisionSource: accessSource,
    byteRangeStart,
    byteRangeEnd,
    capabilityId: capabilityPayload.jti,
    ipAddress,
  });
  await enqueueAnalyticsEvent({
    db,
    event: buildAnalyticsEvent({
      materialId,
      eventType: 'download',
      viewerId: buyerAddress,
      ipAddress,
      userAgent: request.headers.get('user-agent') || '',
      headers: { accept: request.headers.get('accept') || '' },
      dwellMs: 1000,
      interactionCount: 1,
      source: 'server-confirmed',
    }),
  });

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
        byteRangeStart,
        byteRangeEnd: byteRangeEnd !== null ? byteRangeEnd : null,
        nonce,
        quotaBytes: effectiveByteRangeQuota,
        maxBytes: effectiveByteRangeQuota,
        expiresInMs: effectiveTtlMs,
        expiresAt: new Date(capabilityPayload.exp).toISOString(),
      },
    },
    {
      headers: {
        'Cache-Control': 'private, max-age=60',
        'X-Entitlement-Source': accessSource,
        // Do NOT forward the raw capability token or buyer address to the gateway;
        // only the derived byte-range parameters are passed through.
        'X-Capability-Byte-Range-Start': String(byteRangeStart),
        'X-Capability-Byte-Range-End': byteRangeEnd !== null ? String(byteRangeEnd) : '',
      },
    }
  );
}

async function handlePost(request) {
  const user = await getUserFromCookie(request);
  if (!user) {
    return renderProblemResponse("AUTH_UNAUTHENTICATED", request, "Authentication required");
  }

  const userAddress = normalizeBuyerAddress(user.walletAddress || user.address || user.id);
  if (!userAddress) {
    return renderProblemResponse("VALIDATION_FIELD", request, "No wallet address on account");
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return renderProblemResponse("VALIDATION_FIELD", request, "Invalid JSON request body");
  }

  const { token, materialId, requestedBytes, range } = body ?? {};
  if (!token || typeof token !== 'string') {
    return renderProblemResponse("VALIDATION_FIELD", request, "Missing signed download token");
  }

  let requestedRangeStart;
  let requestedRangeEnd;
  if (range !== undefined && range !== null && range !== '') {
    const parsed = parseByteRangeParam(range);
    if (!parsed.ok) {
      return renderProblemResponse("VALIDATION_FIELD", request, parsed.message);
    }
    requestedRangeStart = parsed.byteRangeStart;
    requestedRangeEnd = parsed.byteRangeEnd;
  }

  const verification = verifyCapabilityToken(token, {
    buyerAddress: userAddress,
    materialId: materialId || undefined,
    requestedBytes,
    requestedRangeStart,
    requestedRangeEnd,
  });

  if (!verification.valid) {
    const status =
      verification.reason === 'expired'
        ? 410
        : verification.reason === 'requested_bytes_exceed_limit' ||
            verification.reason === 'requested_range_out_of_bounds' ||
            verification.reason === 'byte_range_exceeds_max'
          ? 416
          : 403;
    return NextResponse.json(
      {
        ok: false,
        authorized: false,
        error: verification.reason === 'expired'
          ? 'Download authorization expired'
          : status === 416
            ? 'Requested byte range or size exceeds authorized limit'
            : 'Download authorization rejected',
      },
      { status }
    );
  }

  return NextResponse.json(
    {
      ok: true,
      authorized: true,
      materialId: verification.payload.material,
      capabilityId: verification.payload.jti,
      maxBytes: verification.payload.maxBytes ?? verification.payload.byteRangeQuota,
      expiresAt: new Date(verification.payload.exp).toISOString(),
    },
    {
      headers: {
        'Cache-Control': 'private, no-store',
      },
    }
  );
}

export const GET = withTelemetryRoute(
  'material.download',
  ACTOR_TYPES.USER,
  (request, context) =>
    withApiErrorHandling(
      request,
      { route: "material-download" },
      () => handleGet(request, context)
    )
);

export const POST = withTelemetryRoute(
  'material.download.verify',
  ACTOR_TYPES.USER,
  (request, context) =>
    withApiErrorHandling(
      request,
      { route: "material-download-verify" },
      () => handlePost(request, context)
    )
);
