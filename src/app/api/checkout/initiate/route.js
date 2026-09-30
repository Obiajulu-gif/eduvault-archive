export const dynamic = "force-dynamic";

import { NextResponse } from 'next/server';
import { getUserFromCookie } from "@/lib/api/auth";
import { applyTaxToCheckout } from '@/lib/checkout/taxEstimator';
import { getDb } from '@/lib/mongodb';
import { findMaterial, verifyDiscount } from '@/lib/checkout/discountVerifier';
import { checkBuyerTrustline } from '@/lib/stellar/horizonClient';
import {
  CHECKOUT_INTENT_EXPIRY,
  ensureCheckoutIntentIndexes,
  findIntentByIdempotencyKey,
  insertCheckoutIntent,
} from '@/lib/checkout/checkoutIntentStore';

/**
 * POST /api/checkout/initiate
 * Initiates a checkout with tax estimation based on buyer's geolocation
 *
 * Idempotency: clients may supply an `idempotencyKey` (or the `X-Idempotency-Key`
 * header). When present, a concurrent or retried request with the same key
 * returns the existing intent instead of creating a duplicate record.
 */
export async function POST(req) {
  try {
    const user = await getUserFromCookie(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { materialId, amount, asset, buyerIp, buyerCountry, discountCode } = body;
    const idempotencyKey =
      body.idempotencyKey || req.headers.get('x-idempotency-key') || null;

    // Validate required fields
    if (!materialId) {
      return NextResponse.json({ error: 'Missing materialId' }, { status: 400 });
    }

    if (!amount || amount <= 0) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }

    if (!asset) {
      return NextResponse.json({ error: 'Missing asset' }, { status: 400 });
    }

    const buyerAddress = user.walletAddress || user.address || user.id;

    const db = await getDb();
    await ensureCheckoutIntentIndexes(db);

    // Fast path for retries: return the existing intent without re-running
    // tax / trustline / discount side effects.
    if (idempotencyKey) {
      const existing = await findIntentByIdempotencyKey(db, buyerAddress, idempotencyKey);
      if (existing) {
        return NextResponse.json(
          {
            success: true,
            duplicate: true,
            checkoutId: existing._id,
            checkout: {
              checkoutId: existing._id,
              expiresAt: existing.expiresAt,
              totalAmount: existing.totalAmount,
              taxAmount: existing.taxAmount,
              taxRateBps: existing.taxRateBps,
              geolocation: existing.geolocation,
              discountCode: existing.discountCode,
              discountPercentage: existing.discountPercentage,
              discountAmount: existing.discountAmount,
              originalAmount: existing.originalAmount,
            },
          },
          { status: 200 }
        );
      }
    }

    // Resolve material to verify standard pricing and prevent price tampering
    const material = await findMaterial(materialId);
    let basePrice = amount;
    if (material) {
      basePrice = material.price;
    }

    // Verify discount code if supplied
    let verifiedDiscount = null;
    let finalBaseAmount = basePrice;
    if (discountCode) {
      const discountResult = await verifyDiscount(discountCode, materialId);
      if (discountResult.valid) {
        verifiedDiscount = discountResult.discount;
        const discountPercent = discountResult.discountAmountPercent || 0;
        finalBaseAmount = basePrice * (1 - discountPercent / 100);
      }
    }

    // Verify buyer holds an active trustline for the payment asset
    const assetCode = typeof asset === 'string' ? asset : asset.code || asset;
    const issuerAddress = typeof asset === 'object' ? asset.issuer : undefined;
    const trustlineCheck = await checkBuyerTrustline(buyerAddress, assetCode, issuerAddress);

    if (!trustlineCheck.hasTrustline) {
      return NextResponse.json({
        error: 'missing_trustline',
        message: trustlineCheck.instructions.message,
        instructions: trustlineCheck.instructions,
      }, { status: 400 });
    }

    // Get buyer IP from request if not provided
    const ipAddress = buyerIp || req.headers.get('x-forwarded-for')?.split(',')[0] || req.headers.get('x-real-ip') || null;

    // Apply tax estimation to the verified and discounted base amount
    const checkoutWithTax = await applyTaxToCheckout({
      materialId,
      amount: finalBaseAmount,
      asset,
      buyerIp: ipAddress,
      buyerCountry,
      buyerAddress,
    });

    // Store checkout intent in database for later processing
    const now = new Date();
    const checkoutIntent = {
      materialId,
      buyerAddress,
      idempotencyKey,
      originalAmount: basePrice,
      discountCode: discountCode || null,
      discountPercentage: verifiedDiscount ? (verifiedDiscount.percentage || 0) : 0,
      discountAmount: basePrice - finalBaseAmount,
      taxAmount: checkoutWithTax.taxAmount,
      taxRateBps: checkoutWithTax.taxRateBps,
      totalAmount: checkoutWithTax.totalAmount,
      asset,
      geolocation: checkoutWithTax.geolocation,
      status: 'initiated',
      createdAt: now,
      expiresAt: new Date(now.getTime() + CHECKOUT_INTENT_EXPIRY),
    };

    const { intent: storedIntent, duplicate } = await insertCheckoutIntent(db, checkoutIntent);

    return NextResponse.json(
      {
        success: true,
        duplicate,
        checkoutId: storedIntent._id,
        checkout: {
          ...checkoutWithTax,
          checkoutId: storedIntent._id,
          expiresAt: storedIntent.expiresAt,
          discountCode: storedIntent.discountCode,
          discountPercentage: storedIntent.discountPercentage,
          discountAmount: storedIntent.discountAmount,
          originalAmount: storedIntent.originalAmount,
        },
      },
      { status: duplicate ? 200 : 201 }
    );
  } catch (err) {
    console.error('POST /api/checkout/initiate error:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

/**
 * GET /api/checkout/initiate
 * Get tax estimation without creating a checkout intent
 */
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const amount = parseFloat(searchParams.get('amount'));
    const asset = searchParams.get('asset');
    const buyerIp = searchParams.get('buyerIp');
    const buyerCountry = searchParams.get('buyerCountry');

    if (!amount || amount <= 0) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }

    const checkoutWithTax = await applyTaxToCheckout({
      amount,
      asset,
      buyerIp,
      buyerCountry,
    });

    return NextResponse.json({
      success: true,
      estimation: checkoutWithTax,
    });
  } catch (err) {
    console.error('GET /api/checkout/initiate error:', err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
