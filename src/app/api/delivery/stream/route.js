/**
 * GET /api/delivery/stream
 *
 * Authenticated streaming proxy for protected content.
 *
 * Query params:
 *   - token       : Short-lived delivery token from POST /api/delivery/token
 *   - materialId  : The material to stream
 *
 * Headers (optional):
 *   - Range       : RFC 7233 byte range for partial content / resume
 *
 * This endpoint:
 *   - Verifies the delivery token (expiry, audience, optional nonce)
 *   - Fetches the material CID from the database (never exposed to client)
 *   - Proxies the file stream from the IPFS gateway through the server
 *   - Supports backpressure, cancellation, range requests, and timeouts
 *   - Records audit events for every delivery
 *   - Never exposes the permanent CID or gateway URL to the client
 */

import { NextResponse } from 'next/server';
import { withApiHardening } from '@/lib/api/hardening';
import { verifyDeliveryToken } from '@/lib/delivery/token';
import { getMaterialRecord, createUpstreamStream, parseRangeHeader } from '@/lib/delivery/stream';
import { recordDeliveryAudit } from '@/lib/delivery/audit';
import { contentDispositionAttachment } from '@/lib/security/input';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  return withApiHardening(
    request,
    {
      route: 'delivery-stream',
      rateLimit: {
        limit: 100,
        windowMs: 60_000, // 100 stream requests/min per IP
      },
    },
    async () => {
      const startedAt = Date.now();
      const { searchParams } = new URL(request.url);
      const token = searchParams.get('token') ?? '';
      const materialId = searchParams.get('materialId') ?? '';

      // ── 1. Validate params ──────────────────────────────────────────────────
      if (!token || !materialId) {
        await recordDeliveryAudit({
          event: 'delivery_stream_denied',
          result: 'missing_params',
          statusCode: 400,
        });
        return NextResponse.json(
          { error: 'token and materialId are required' },
          { status: 400 }
        );
      }

      // ── 2. Verify delivery token ────────────────────────────────────────────
      const clientIp =
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        request.headers.get('x-real-ip') ||
        null;

      const verification = await verifyDeliveryToken(token, {
        expectedMaterial: materialId,
        clientIp: process.env.DELIVERY_IP_BINDING === 'true' ? clientIp : null,
      });

      if (!verification.valid) {
        await recordDeliveryAudit({
          event: 'delivery_stream_denied',
          materialId,
          result: 'invalid_token',
          errorReason: verification.reason,
          statusCode: 401,
          clientIp,
          durationMs: Date.now() - startedAt,
        });

        const statusCode = verification.reason === 'token_expired' ? 410 : 401;
        return NextResponse.json(
          {
            error: 'Access denied',
            detail:
              verification.reason === 'token_expired'
                ? 'Delivery token has expired. Request a new one.'
                : 'Invalid delivery token.',
          },
          { status: statusCode }
        );
      }

      const buyerAddress = verification.payload.ba;

      // ── 3. Get material record with CID ─────────────────────────────────────
      const material = await getMaterialRecord(materialId);
      if (!material || !material.cid) {
        await recordDeliveryAudit({
          event: 'delivery_stream_error',
          actor: verification.payload?.ba,
          buyerAddress,
          materialId,
          result: 'material_not_found',
          statusCode: 404,
          durationMs: Date.now() - startedAt,
        });
        return NextResponse.json(
          { error: 'Material not found' },
          { status: 404 }
        );
      }

      // ── 4. Parse range header ───────────────────────────────────────────────
      const rangeHeader = request.headers.get('range');
      const range = parseRangeHeader(rangeHeader);

      // ── 5. Create abort controller for client disconnect ────────────────────
      const abortController = new AbortController();

      request.signal.addEventListener(
        'abort',
        () => {
          abortController.abort(new Error('client_disconnected'));
        },
        { once: true }
      );

      // ── 6. Create upstream stream ───────────────────────────────────────────
      const upstreamStream = createUpstreamStream({
        cid: material.cid,
        fileSize: material.fileSize,
        range,
        signal: abortController.signal,
      });

      // ── 7. Build response headers ───────────────────────────────────────────
      const headers = {
        'Content-Type': material.contentType,
        'Content-Disposition': contentDispositionAttachment(material.fileName),
        'Cache-Control': 'private, no-cache, no-store, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Accept-Ranges': 'bytes',
      };

      let statusCode = 200;

      if (range) {
        statusCode = 206;
        const contentStart = range.start;
        const contentEnd =
          range.end !== Infinity
            ? range.end
            : material.fileSize > 0
              ? material.fileSize - 1
              : 0;
        const contentLength = contentEnd - contentStart + 1;
        headers['Content-Range'] = `bytes ${contentStart}-${contentEnd}/${material.fileSize || contentLength}`;
        headers['Content-Length'] = String(contentLength);
      } else if (material.fileSize > 0) {
        headers['Content-Length'] = String(material.fileSize);
      }

      // ── 8. Audit the stream start (non-blocking) ────────────────────────────
      recordDeliveryAudit({
        event: 'delivery_stream_started',
        actor: verification.payload?.ba,
        buyerAddress,
        materialId,
        bytesRequested: range
          ? range.end === Infinity
            ? null
            : range.end - range.start + 1
          : material.fileSize || null,
        rangeStart: range?.start ?? null,
        rangeEnd: range?.end ?? null,
        result: 'started',
        statusCode,
        durationMs: Date.now() - startedAt,
        clientIp,
        userAgent: request.headers.get('user-agent') || null,
      }).catch(() => {}); // Non-blocking

      // ── 9. Return streamed response ─────────────────────────────────────────
      return new NextResponse(upstreamStream, {
        status: statusCode,
        headers,
      });
    }
  );
}
