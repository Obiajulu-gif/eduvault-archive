export const dynamic = "force-dynamic";

import { NextResponse } from 'next/server';
import { getUserFromCookie } from "@/lib/api/auth";
import { findMaterial, verifyDiscount } from "@/lib/checkout/discountVerifier";
import { getTaxRateForCountry } from "@/lib/checkout/taxEstimator";
import {
  CheckoutIntentError,
  CHECKOUT_INTENT_ERROR_CODES,
  createSignedCheckoutIntent,
  percentToBasisPoints,
} from "@/lib/checkout/intent";
import { PURCHASE_MANAGER_CONTRACT_ID } from "@/lib/config/chain";
import { getDb } from "@/lib/mongodb";
import { getLatestManifest } from "@/lib/provenance/registry";
import { checkBuyerTrustline } from "@/lib/stellar/horizonClient";

const STELLAR_NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK || "TESTNET";
const PLATFORM_FEE_BPS = Number.parseInt(process.env.PLATFORM_FEE_BPS || "0", 10);

function intentErrorResponse(error) {
  return NextResponse.json(
    { error: error.message, code: error.code || CHECKOUT_INTENT_ERROR_CODES.UNSUPPORTED },
    { status: error.status || 400 },
  );
}

/**
 * POST /api/checkout/initiate
 *
 * Creates a server-authenticated checkout intent. The signed terms freeze the
 * buyer, material/version, seller, network, purchase contract, asset, integer
 * amount, fee breakdown, expiry, and nonce.
 */
export async function POST(req) {
  try {
    const user = await getUserFromCookie(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { materialId, asset, buyerCountry, discountCode } = body;

    if (!materialId) {
      return NextResponse.json({ error: "Missing materialId" }, { status: 400 });
    }

    if (!asset) {
      return NextResponse.json({ error: "Missing asset" }, { status: 400 });
    }

    if (!PURCHASE_MANAGER_CONTRACT_ID) {
      return NextResponse.json(
        { error: "Purchase manager contract is not configured", code: CHECKOUT_INTENT_ERROR_CODES.UNSUPPORTED },
        { status: 500 },
      );
    }

    const db = await getDb();
    const material = await findMaterial(materialId, db);
    if (!material) {
      return NextResponse.json(
        { error: "Material not found", code: CHECKOUT_INTENT_ERROR_CODES.UNSUPPORTED },
        { status: 404 },
      );
    }

    const buyerAddress = user.walletAddress || user.address || user.id;
    if (!buyerAddress) {
      return NextResponse.json({ error: "Missing buyer address" }, { status: 400 });
    }

    const assetCode = typeof asset === "string" ? asset : asset.code;
    const issuerAddress = typeof asset === "object" ? asset.issuer : undefined;
    const trustlineCheck = await checkBuyerTrustline(buyerAddress, assetCode, issuerAddress);
    if (!trustlineCheck.hasTrustline) {
      return NextResponse.json(
        {
          error: "missing_trustline",
          code: CHECKOUT_INTENT_ERROR_CODES.UNSUPPORTED,
          message: trustlineCheck.instructions.message,
          instructions: trustlineCheck.instructions,
        },
        { status: 400 },
      );
    }

    let verifiedDiscount = null;
    let discountBps = 0;
    if (discountCode) {
      const discountResult = await verifyDiscount(discountCode, materialId, db);
      if (!discountResult.valid) {
        return NextResponse.json(
          { error: discountResult.reason, code: CHECKOUT_INTENT_ERROR_CODES.CHANGED },
          { status: 409 },
        );
      }
      verifiedDiscount = discountResult.discount;
      discountBps = percentToBasisPoints(discountResult.discountAmountPercent || 0);
    }

    let latestManifest = null;
    try {
      latestManifest = await getLatestManifest(materialId);
    } catch (error) {
      console.warn("[checkout/initiate] Failed to resolve latest manifest:", error?.message);
    }

    const signedIntent = createSignedCheckoutIntent({
      buyerAddress,
      materialId,
      material,
      materialVersion: latestManifest?.version || null,
      manifestDigest: latestManifest?.digest || null,
      sellerAddress: material.creatorAddress || material.userAddress || material.authorAddress || null,
      network: STELLAR_NETWORK,
      contractId: PURCHASE_MANAGER_CONTRACT_ID,
      asset,
      discountBps,
      taxBps: getTaxRateForCountry(buyerCountry),
      platformFeeBps: Number.isSafeInteger(PLATFORM_FEE_BPS) ? PLATFORM_FEE_BPS : 0,
    });

    const checkoutIntent = {
      ...signedIntent,
      materialId,
      buyerAddress: signedIntent.terms.buyer,
      status: "initiated",
      createdAt: new Date(signedIntent.terms.issuedAt),
      expiresAt: new Date(signedIntent.terms.expiry),
      consumedAt: null,
      discountCode: discountCode || null,
      discountPolicy: verifiedDiscount
        ? {
            id: String(verifiedDiscount._id || verifiedDiscount.id || discountCode),
            percentage: verifiedDiscount.percentage || 0,
            usageLimit: verifiedDiscount.usageLimit ?? null,
            usageCount: verifiedDiscount.usageCount ?? null,
          }
        : null,
    };

    const result = await db.collection("checkout_intents").insertOne(checkoutIntent);

    return NextResponse.json(
      {
        success: true,
        checkoutId: String(result.insertedId),
        checkout: {
          checkoutId: String(result.insertedId),
          intentHash: signedIntent.intentHash,
          signature: signedIntent.signature,
          terms: signedIntent.terms,
          expiresAt: signedIntent.terms.expiry,
          amount: signedIntent.terms.amount.display,
          amountUnits: signedIntent.terms.amount.units,
          asset: signedIntent.terms.asset,
          feeBreakdown: signedIntent.terms.feeBreakdown,
          discountCode: checkoutIntent.discountCode,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof CheckoutIntentError) {
      return intentErrorResponse(err);
    }

    console.error("POST /api/checkout/initiate error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

/**
 * GET /api/checkout/initiate
 *
 * Returns the deterministic tax rate that would be used for a signed intent.
 */
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const buyerCountry = searchParams.get("buyerCountry");

    return NextResponse.json({
      success: true,
      estimation: {
        taxRateBps: getTaxRateForCountry(buyerCountry),
      },
    });
  } catch (err) {
    console.error("GET /api/checkout/initiate error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}