export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/api/auth';
import {
  CHECKOUT_BLOCK_CODES,
  CHECKOUT_MUTATIONS,
  checkoutAbuseController,
} from '@/lib/checkout/checkoutAbuseControl';
import logger from '@/lib/logger';

/**
 * GET /api/admin/checkout-abuse
 * Admin/service observability endpoint for blocked/flagged checkout mutation
 * rate-limit and abuse-control events (#1188).
 */
export async function GET(req) {
  const auth = await requirePermission(req, 'operations:read', { allowService: true });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { searchParams } = new URL(req.url);
  const mutation = searchParams.get('mutation') || undefined;
  const code = searchParams.get('code') || undefined;
  const limitParam = searchParams.get('limit');
  const sinceMsParam = searchParams.get('sinceMs');

  if (mutation && !CHECKOUT_MUTATIONS.includes(mutation)) {
    return NextResponse.json(
      { error: `mutation must be one of: ${CHECKOUT_MUTATIONS.join(', ')}` },
      { status: 400 }
    );
  }

  if (code && !CHECKOUT_BLOCK_CODES.includes(code)) {
    return NextResponse.json(
      { error: `code must be one of: ${CHECKOUT_BLOCK_CODES.join(', ')}` },
      { status: 400 }
    );
  }

  const data = checkoutAbuseController.getEvents({
    mutation,
    code,
    limit: limitParam ? Number(limitParam) : 100,
    sinceMs: sinceMsParam ? Number(sinceMsParam) : undefined,
  });

  return NextResponse.json({ success: true, data }, { status: 200 });
}

/**
 * POST /api/admin/checkout-abuse
 * Admin recovery endpoint to reset checkout rate-limit windows and active
 * failure cooldowns after false positives or incident recovery (#1188).
 */
export async function POST(req) {
  const auth = await requirePermission(req, 'checkout:abuse:manage');
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const body = await req.json().catch(() => ({}));
  const { wallet, ip, mutation, clearEvents } = body || {};

  if (mutation && !CHECKOUT_MUTATIONS.includes(mutation)) {
    return NextResponse.json(
      { error: `mutation must be one of: ${CHECKOUT_MUTATIONS.join(', ')}` },
      { status: 400 }
    );
  }

  checkoutAbuseController.reset({ wallet, ip, mutation, clearEvents });

  logger.info(
    {
      actor: auth.user?.sub || auth.user?.id || 'admin',
      mutation: mutation || 'all',
      walletScoped: Boolean(wallet),
      ipScoped: Boolean(ip),
    },
    'Checkout abuse controls reset by admin'
  );

  return NextResponse.json(
    {
      success: true,
      reset: true,
      scope: {
        mutation: mutation || 'all',
        walletScoped: Boolean(wallet),
        ipScoped: Boolean(ip),
      },
    },
    { status: 200 }
  );
}
