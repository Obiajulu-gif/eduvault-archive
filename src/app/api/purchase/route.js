export const dynamic = "force-dynamic";

import { getDb } from '@/lib/mongodb'
import { NextResponse } from 'next/server'
import { getUserFromCookie } from "@/lib/api/auth";
import { createEntitlement } from '@/lib/entitlement';
import {
  getMaterialAccessStatus,
  isCompletedPurchaseStatus,
  normalizeBuyerAddress,
} from "@/lib/purchases/access";
import { broadcastPurchaseEvent } from '@/lib/webhooks/sender';
import { sendReceiptIfEligible } from '@/lib/email';
import { createCheckoutQuote, consumeCheckoutQuote } from '@/lib/checkout/quotes';
import { buildAnalyticsEvent, recordServerAnalyticsEvent } from '@/lib/backend/analyticsEvents';

function duplicateKey(error) {
  return error?.code === 11000;
}

// Shared by both the pre-check "already purchased" path and the
// post-insert race path (a concurrent request won the unique-index race),
// so side effects (entitlement/receipt/webhook) fire exactly once per
// actual purchase regardless of which path resolves it.
/**
 * Fire a server-confirmed purchase analytics event. This is a fire-and-forget
 * call — it MUST NOT throw and block the purchase response.
 */
function recordPurchaseAnalytics(db, { materialId, buyerAddress }) {
  const event = buildAnalyticsEvent({
    materialId: String(materialId),
    eventType: 'purchase',
    viewerId: buyerAddress,
    source: 'server-confirmed',
  });
  recordServerAnalyticsEvent(db, event).catch(err =>
    console.error('[purchase] analytics recording failed (non-fatal):', err)
  );
}

async function respondForExistingPurchase(db, existing, { materialId, buyerAddress, paymentCompleted, transactionHash, signedXdr, amount, asset, email }) {
  if (isCompletedPurchaseStatus(existing.status)) {
    await createEntitlement(materialId, buyerAddress, {
      purchaseId: String(existing._id),
      transactionHash: existing.transactionHash,
    });
    const access = await getMaterialAccessStatus(db, materialId, buyerAddress);
    // Server-confirmed event: purchase was already finalized, buyer is re-accessing.
    // We still record to deduplicate in the time window — duplicate within window is a no-op.
    recordPurchaseAnalytics(db, { materialId, buyerAddress });
    return NextResponse.json(
      { message: 'Already purchased', purchase: existing, access, transactionHash: existing.transactionHash },
      { status: 200 }
    );
  }

  if (!paymentCompleted) {
    const access = await getMaterialAccessStatus(db, materialId, buyerAddress);
    return NextResponse.json(
      { message: 'Payment pending', purchase: existing, access },
      { status: 202 }
    );
  }

  const now = new Date();
  await db.collection('purchases').updateOne(
    { _id: existing._id },
    {
      $set: {
        status: 'confirmed',
        transactionHash: transactionHash || existing.transactionHash || null,
        signedXdr: signedXdr || existing.signedXdr || null,
        amount: amount ?? existing.amount ?? null,
        asset: asset || existing.asset || null,
        userEmail: email || existing.userEmail || null,
        purchasedAt: existing.purchasedAt || now,
        confirmedAt: now,
        updatedAt: now,
      },
    }
  );

  const purchase = await db.collection('purchases').findOne({ _id: existing._id });
  const access = await getMaterialAccessStatus(db, materialId, buyerAddress);

  sendReceiptIfEligible(db, existing._id).catch(err => console.error(err));
  // Fire server-confirmed purchase analytics — authoritative, immune to ad blockers.
  recordPurchaseAnalytics(db, { materialId, buyerAddress });
  // Fire webhook asynchronously
  broadcastPurchaseEvent(materialId, {
    buyerAddress,
    amount: amount ?? existing.amount,
    asset: asset || existing.asset,
    transactionHash: transactionHash || existing.transactionHash
  });

  return NextResponse.json(
    { success: true, purchaseId: existing._id, purchase, access, transactionHash: purchase?.transactionHash },
    { status: 200 }
  );
}

export async function GET(req) {
  try {
    const user = await getUserFromCookie(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = await getDb();
    const userAddress = normalizeBuyerAddress(user.walletAddress || user.address || user.id);

    const purchases = await db
      .collection("purchases")
      .find({ buyerAddress: userAddress })
      .sort({ createdAt: -1 })
      .toArray();

    return NextResponse.json(purchases);
  } catch (err) {
    console.error("GET /api/purchase error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const user = await getUserFromCookie(req);
    const db = await getDb();
    const body = await req.json();

    const { materialId, signedXdr, email, transactionHash, amount, asset, quoteId, action, buyerAddress: bodyBuyerAddress } = body;
    const buyerAddress = normalizeBuyerAddress(
      user?.walletAddress || user?.address || user?.id || bodyBuyerAddress
    );
    const paymentCompleted = Boolean(transactionHash || signedXdr);

    if (!materialId) {
      return NextResponse.json({ error: "Missing materialId" }, { status: 400 });
    }

    if (!buyerAddress) {
      return NextResponse.json({ error: user ? "Missing buyer address" : "Unauthorized" }, { status: user ? 400 : 401 });
    }

    if (action === 'quote') {
      const quote = await createCheckoutQuote(db, { materialId, buyerAddress });
      return NextResponse.json({ quoteId: quote.quoteId, materialId: quote.materialId, ...quote.terms, expiresAt: quote.expiresAt }, { status: 201 });
    }

    const existing = await db.collection('purchases').findOne({ buyerAddress, materialId });
    if (existing && isCompletedPurchaseStatus(existing.status)) {
      return respondForExistingPurchase(db, existing, { materialId, buyerAddress, paymentCompleted, transactionHash, signedXdr, amount, asset, email });
    }

    if (paymentCompleted && !quoteId) {
      return NextResponse.json({ error: 'A valid checkout quote is required. Refresh the listing and try again.' }, { status: 409 });
    }

    let quote = null;
    if (paymentCompleted) {
      try {
        quote = await consumeCheckoutQuote(db, { quoteId, materialId, buyerAddress });
      } catch (error) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
      }
    }

    const quotedAmount = quote?.terms?.price ?? amount;
    const quotedAsset = quote?.terms?.asset ?? asset;

    const purchaseContext = { materialId, buyerAddress, paymentCompleted, transactionHash, signedXdr, amount: quotedAmount, asset: quotedAsset, email };

    // Prevent duplicate purchases
    if (existing) {
      return respondForExistingPurchase(db, existing, purchaseContext);
    }

    const now = new Date();

    const purchaseRecord = {
      materialId,
      buyerAddress,
      userEmail: email || null,
      status: paymentCompleted ? 'confirmed' : 'pending',
      transactionHash: transactionHash || null,
      signedXdr: signedXdr || null,
      amount: quotedAmount ?? null,
      asset: quotedAsset || null,
      quoteId: quote?.quoteId || null,
      purchaseSnapshot: quote?.terms || null,
      purchasedAt: paymentCompleted ? now : null,
      confirmedAt: paymentCompleted ? now : null,
      createdAt: now,
      updatedAt: now,
    };

    let result;
    try {
      result = await db.collection('purchases').insertOne(purchaseRecord);
    } catch (error) {
      if (duplicateKey(error)) {
        // Another concurrent request won the unique-index race; converge
        // on that document instead of erroring or creating a duplicate.
        const winner = await db.collection('purchases').findOne({ buyerAddress, materialId });
        if (winner) {
          return respondForExistingPurchase(db, winner, purchaseContext);
        }
      }
      throw error;
    }
    const access = await getMaterialAccessStatus(db, materialId, buyerAddress);

    if (paymentCompleted) {
      await createEntitlement(materialId, buyerAddress, {
        purchaseId: String(result.insertedId),
        transactionHash: transactionHash || null,
      });

      sendReceiptIfEligible(db, result.insertedId).catch(err => console.error(err));
      // Server-confirmed purchase analytics — written immediately without the
      // outbox queue so they survive even if the client page is closed right
      // after payment. Never allowed to throw and disrupt the purchase response.
      recordPurchaseAnalytics(db, { materialId, buyerAddress });

      // Fire webhook asynchronously
      broadcastPurchaseEvent(materialId, purchaseRecord);
    }

    return NextResponse.json(
      { success: paymentCompleted, purchaseId: result.insertedId, purchase: { ...purchaseRecord, _id: result.insertedId }, access },
      { status: paymentCompleted ? 201 : 202 }
    );
  } catch (err) {
    console.error("POST /api/purchase error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
