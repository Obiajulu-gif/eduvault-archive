/**
 * POST /api/delivery/token
 *
 * Issues a short-lived, audience-bound delivery token after verifying
 * entitlement. This replaces the old pattern of returning the raw IPFS URL.
 *
 * The token is bound to:
 *   - The authenticated user (from session cookie)
 *   - The requested material
 *   - A 15-minute expiry
 *   - An optional single-use nonce
 *
 * The client then uses this token to call GET /api/delivery/stream
 * which proxies the file bytes without exposing the CID.
 */

import { NextResponse } from 'next/server';
import { getUserFromCookie } from '@/lib/api/auth';
import { withApiHardening } from '@/lib/api/hardening';
import { verifyEntitlement } from '@/lib/entitlement';
import { issueDeliveryToken } from '@/lib/delivery/token';
import { getMaterialRecord } from '@/lib/delivery/stream';
import { recordDeliveryAudit } from '@/lib/delivery/audit';
import { normalizeBuyerAddress } from '@/lib/purchases/access';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  return withApiHardening(
    request,
    {
      route: 'delivery-token',
      rateLimit: { limit: 30, windowMs: 60_000 }, // 30 tokens/min per client
    },
    async () => {
      const startedAt = Date.now();

      try {
        // ── 1. Authenticate ──────────────────────────────────────────────────
        const user = await getUserFromCookie(request);
        if (!user) {
          await recordDeliveryAudit({
            event: 'delivery_token_denied',
            result: 'unauthenticated',
            statusCode: 401,
          });
          return NextResponse.json(
            { error: 'Authentication required' },
            { status: 401 }
          );
        }

        const buyerAddress = normalizeBuyerAddress(
          user.walletAddress || user.address || user.id
        );
        if (!buyerAddress) {
          await recordDeliveryAudit({
            event: 'delivery_token_denied',
            actor: user.sub,
            result: 'no_wallet_address',
            statusCode: 400,
          });
          return NextResponse.json(
            { error: 'No wallet address on account' },
            { status: 400 }
          );
        }

        // ── 2. Parse request body ────────────────────────────────────────────
        let body;
        try {
          body = await request.json();
        } catch {
          return NextResponse.json(
            { error: 'Invalid JSON body' },
            { status: 400 }
          );
        }

        const { materialId, singleUse = false, ttlSeconds } = body;

        if (!materialId || typeof materialId !== 'string') {
          return NextResponse.json(
            { error: 'materialId is required' },
            { status: 400 }
          );
        }

        // ── 3. Verify entitlement ────────────────────────────────────────────
        const entitlement = await verifyEntitlement(materialId, buyerAddress);
        if (!entitlement.hasAccess) {
          await recordDeliveryAudit({
            event: 'delivery_token_denied',
            actor: user.sub,
            buyerAddress,
            materialId,
            result: 'no_entitlement',
            statusCode: 403,
          });
          return NextResponse.json(
            {
              error: 'Access denied',
              detail: 'You do not hold an active entitlement for this material.',
            },
            { status: 403 }
          );
        }

        // ── 4. Get material record (validate it exists) ──────────────────────
        const material = await getMaterialRecord(materialId);
        if (!material) {
          await recordDeliveryAudit({
            event: 'delivery_token_denied',
            actor: user.sub,
            buyerAddress,
            materialId,
            result: 'material_not_found',
            statusCode: 404,
          });
          return NextResponse.json(
            { error: 'Material not found' },
            { status: 404 }
          );
        }

        // ── 5. Issue delivery token ──────────────────────────────────────────
        const clientIp =
          request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
          request.headers.get('x-real-ip') ||
          null;

        const { token, expiresAt } = await issueDeliveryToken({
          buyerAddress,
          materialId,
          ttlSeconds: ttlSeconds || 15 * 60,
          singleUse,
          ipRestriction: null, // IP binding is optional; set via env if needed
        });

        // ── 6. Audit ─────────────────────────────────────────────────────────
        await recordDeliveryAudit({
          event: 'delivery_token_issued',
          actor: user.sub,
          buyerAddress,
          materialId,
          result: 'success',
          statusCode: 200,
          durationMs: Date.now() - startedAt,
          userAgent: request.headers.get('user-agent') || null,
          clientIp,
        });

        // ── 7. Return token (NOT the CID or gateway URL) ─────────────────────
        return NextResponse.json(
          {
            success: true,
            token,
            expiresAt,
            materialId,
            fileName: material.fileName,
            contentType: material.contentType,
            fileSize: material.fileSize,
            // No CID, no gateway URL — the token is the only access credential
          },
          {
            headers: {
              'Cache-Control': 'private, no-store',
              'X-Token-Expires': String(expiresAt),
            },
          }
        );
      } catch (err) {
        await recordDeliveryAudit({
          event: 'delivery_token_error',
          result: 'error',
          errorReason: err.message,
          statusCode: 500,
          durationMs: Date.now() - startedAt,
        });
        return NextResponse.json(
          { error: 'Failed to issue delivery token' },
          { status: 500 }
        );
      }
    }
  );
}