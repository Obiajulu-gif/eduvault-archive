export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';

/**
 * POST /api/checkout/verify-promo
 *
 * Verifies a promo code and returns discount details.
 *
 * Body:
 *   { code: string, materialId?: string }
 *
 * Returns:
 *   { valid: true, code, discountPercent, discountLabel, expiresAt }
 *   or { valid: false, error: 'expired' | 'invalid_code' | ... }
 */
export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { code, materialId } = body;

    if (!code || typeof code !== 'string') {
      return NextResponse.json(
        { valid: false, error: 'missing_code', message: 'Promo code is required.' },
        { status: 400 }
      );
    }

    const normalizedCode = code.trim().toUpperCase();
    const db = await getDb();
    const promoCollection = db.collection('promo_codes');

    const promo = await promoCollection.findOne({ code: normalizedCode });

    if (!promo) {
      return NextResponse.json(
        { valid: false, error: 'invalid_code', message: 'Invalid promo code.' },
        { status: 200 }
      );
    }

    if (promo.active === false) {
      return NextResponse.json(
        { valid: false, error: 'inactive', message: 'This promo code is no longer active.' },
        { status: 200 }
      );
    }

    if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) {
      return NextResponse.json(
        { valid: false, error: 'expired', message: 'This promo code has expired.' },
        { status: 200 }
      );
    }

    if (promo.maxUses && promo.usedCount >= promo.maxUses) {
      return NextResponse.json(
        { valid: false, error: 'max_uses_reached', message: 'This promo code has reached its usage limit.' },
        { status: 200 }
      );
    }

    // If materialId is provided, check if the promo is restricted to specific materials
    if (materialId && promo.materialIds && Array.isArray(promo.materialIds) && promo.materialIds.length > 0) {
      if (!promo.materialIds.includes(materialId)) {
        return NextResponse.json(
          { valid: false, error: 'not_applicable', message: 'This promo code is not valid for the selected item.' },
          { status: 200 }
        );
      }
    }

    const discountPercent = Number(promo.discountPercent) || 0;
    if (discountPercent <= 0 || discountPercent > 100) {
      return NextResponse.json(
        { valid: false, error: 'invalid_discount', message: 'This promo code has an invalid discount value.' },
        { status: 200 }
      );
    }

    return NextResponse.json({
      valid: true,
      code: normalizedCode,
      discountPercent,
      discountLabel: promo.label || `${discountPercent}% off`,
      expiresAt: promo.expiresAt || null,
      maxUses: promo.maxUses || null,
      usedCount: promo.usedCount || 0,
    }, { status: 200 });
  } catch (err) {
    console.error('POST /api/checkout/verify-promo error:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
