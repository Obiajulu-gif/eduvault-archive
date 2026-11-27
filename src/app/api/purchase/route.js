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
import {
  createCheckoutQuote,
  consumeCheckoutQuote,
  validateCheckoutQuote,
  STALE_QUOTE_REASONS,
} from '@/lib/checkout/quotes';
import { buildAnalyticsEvent, recordServerAnalyticsEvent } from '@/lib/backend/analyticsEvents';
import { appendCriticalMutation } from '@/lib/backend/auditLedger';
import { withTelemetryRoute, ACTOR_TYPES } from '@/lib/monitoring/telemetry';
import { AppError, isAppError } from '@/lib/errors/AppError.js';
import { renderErrorResponse, renderProblemResponse } from '@/lib/errors/renderErrorResponse.js';
import { renderUserSafeErrorBody } from '@/lib/errors/userSafeError.js';
import { getCorrelationId } from '@/lib/errors/correlation.js';

const MAX_PRE_SIGN_BUFFER_MS = 60 * 1000;

function renderStaleQuoteResponse(validation, req) {
  const reasonToCode = {
    [STALE_QUOTE_REASONS.BUYER_MISMATCH]: "AUTH_WALLET_MISMATCH",
    [STALE_QUOTE_REASONS.QUOTE_EXPIRED]: "SETTLEMENT_QUOTE_EXPIRED",
    [STALE_QUOTE_REASONS.QUOTE_EXPIRING_SOON]: "SETTLEMENT_QUOTE_EXPIRED",
    [STALE_QUOTE_REASONS.MATERIAL_ARCHIVED]: "NOT_FOUND_MATERIAL",
    [STALE_QUOTE_REASONS.MATERIAL_UNAVAILABLE]: "NOT_FOUND_MATERIAL",
    [STALE_QUOTE_REASONS.TERMS_CHANGED]: "CONFLICT_STATE",
    [STALE_QUOTE_REASONS.QUOTE_CONSUMED]: "CONFLICT_STATE",
    [STALE_QUOTE_REASONS.QUOTE_NOT_FOUND]: "CONFLICT_STATE",
    [STALE_QUOTE_REASONS.MATERIAL_MISMATCH]: "CONFLICT_STATE",
  };

  const reasonToMessage = {
    [STALE_QUOTE_REASONS.BUYER_MISMATCH]: "This checkout quote belongs to a different wallet address. Refresh to request a quote for your active wallet.",
    [STALE_QUOTE_REASONS.QUOTE_EXPIRED]: "Checkout quote expired before signing. Refresh to get a new quote.",
    [STALE_QUOTE_REASONS.QUOTE_EXPIRING_SOON]: "Checkout quote is about to expire before signing can complete. Refresh to get a new quote.",
    [STALE_QUOTE_REASONS.MATERIAL_ARCHIVED]: "This material has been archived and is no longer available for purchase.",
    [STALE_QUOTE_REASONS.MATERIAL_UNAVAILABLE]: "This material is no longer available for purchase.",
    [STALE_QUOTE_REASONS.TERMS_CHANGED]: "Listing terms changed after your quote was issued. Refresh your quote to review the updated terms before signing.",
    [STALE_QUOTE_REASONS.QUOTE_CONSUMED]: "This checkout quote has already been used. Refresh to request a new quote.",
    [STALE_QUOTE_REASONS.QUOTE_NOT_FOUND]: "Checkout quote could not be found. Refresh to request a new quote.",
    [STALE_QUOTE_REASONS.MATERIAL_MISMATCH]: "Checkout quote does not match this material. Refresh to request a new quote.",
  };

  const code = reasonToCode[validation.reason] || "CONFLICT_STATE";
  const correlationId = req ? getCorrelationId(req) : null;
  const instance = req ? new URL(req.url).pathname : "";
  const body = renderUserSafeErrorBody(new AppError(code), { correlationId, instance });

  body.error = reasonToMessage[validation.reason] || body.error;
  body.fresh = false;
  body.stale = true;
  body.reason = validation.reason;
  body.canRefresh = Boolean(validation.canRefresh);
  body.checkedAt = validation.checkedAt;
  if (validation.expiresAt) body.expiresAt = validation.expiresAt;
  if (validation.changedFields) body.changedFields = validation.changedFields;
  if (validation.quoteTerms) body.quoteTerms = validation.quoteTerms;
  if (validation.currentTerms) body.currentTerms = validation.currentTerms;

  const headers = { "Content-Type": "application/problem+json" };
  if (correlationId) headers["X-Correlation-Id"] = correlationId;

  return NextResponse.json(body, { status: body.status, headers });
}

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
  await appendCriticalMutation({
    db,
    operationId: `purchase.confirmed:${String(existing._id)}`,
    actor: buyerAddress,
    action: 'purchase.payment_confirmed',
    target: { type: 'purchase', id: String(existing._id) },
    reason: 'Confirmed checkout payment',
    before: { status: existing.status, amount: existing.amount ?? null, asset: existing.asset ?? null },
    after: { status: purchase.status, amount: purchase.amount ?? null, asset: purchase.asset ?? null, materialId: purchase.materialId },
    intent: { materialId, paymentCompleted: true },
  });
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
      return renderProblemResponse("AUTH_UNAUTHENTICATED", req, "Unauthorized");
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
    return renderErrorResponse(err, { request: req, legacyError: "Server error" });
  }
}

async function handlePost(req) {
  try {
    const user = await getUserFromCookie(req);
    const db = await getDb();
    const body = await req.json();

    const {
      materialId,
      signedXdr,
      email,
      transactionHash,
      amount,
      asset,
      quoteId,
      action,
      minRemainingMs,
      buyerAddress: bodyBuyerAddress,
    } = body;
    const sessionBuyerAddress = normalizeBuyerAddress(
      user?.walletAddress || user?.address || user?.id
    );
    const requestedBuyerAddress = normalizeBuyerAddress(bodyBuyerAddress);
    const buyerAddress = sessionBuyerAddress || requestedBuyerAddress;
    const paymentCompleted = Boolean(transactionHash || signedXdr);

    if (!materialId) {
      return renderProblemResponse("VALIDATION_FIELD", req, "Missing materialId");
    }

    if (sessionBuyerAddress && requestedBuyerAddress && sessionBuyerAddress !== requestedBuyerAddress) {
      return renderProblemResponse(
        "AUTH_WALLET_MISMATCH",
        req,
        "Connected wallet address does not match your authenticated session."
      );
    }

    if (!buyerAddress) {
      return renderProblemResponse(
        user ? "VALIDATION_FIELD" : "AUTH_UNAUTHENTICATED",
        req,
        user ? "Missing buyer address" : "Unauthorized"
      );
    }

    if (action === 'quote') {
      const quote = await createCheckoutQuote(db, { materialId, buyerAddress });
      return NextResponse.json(
        {
          quoteId: quote.quoteId,
          materialId: quote.materialId,
          buyerAddress: quote.buyerAddress,
          ...quote.terms,
          expiresAt: quote.expiresAt,
        },
        { status: 201 }
      );
    }

    if (action === 'validate_quote') {
      if (!quoteId) {
        return renderProblemResponse("VALIDATION_FIELD", req, "Missing quoteId");
      }

      const clampedBufferMs = Math.min(
        MAX_PRE_SIGN_BUFFER_MS,
        Math.max(0, Number(minRemainingMs) || 0)
      );
      const validation = await validateCheckoutQuote(db, {
        quoteId,
        materialId,
        buyerAddress,
        minRemainingMs: clampedBufferMs,
      });

      if (!validation.fresh) {
        return renderStaleQuoteResponse(validation, req);
      }

      return NextResponse.json(
        {
          fresh: true,
          stale: false,
          quoteId: validation.quote.quoteId,
          materialId: validation.quote.materialId,
          buyerAddress: validation.quote.buyerAddress,
          ...validation.quote.terms,
          expiresAt: validation.expiresAt,
          remainingMs: validation.remainingMs,
          checkedAt: validation.checkedAt,
        },
        { status: 200 }
      );
    }

    const existing = await db.collection('purchases').findOne({ buyerAddress, materialId });
    if (existing && isCompletedPurchaseStatus(existing.status)) {
      return respondForExistingPurchase(db, existing, { materialId, buyerAddress, paymentCompleted, transactionHash, signedXdr, amount, asset, email });
    }

    if (paymentCompleted && !quoteId) {
      return renderProblemResponse(
        "CONFLICT_STATE",
        req,
        "A valid checkout quote is required. Refresh the listing and try again."
      );
    }

    let quote = null;
    if (paymentCompleted) {
      try {
        quote = await consumeCheckoutQuote(db, { quoteId, materialId, buyerAddress });
      } catch (error) {
        const code = error?.code === "QUOTE_EXPIRED"
          ? "SETTLEMENT_QUOTE_EXPIRED"
          : "CONFLICT_STATE";
        return renderProblemResponse(
          code,
          req,
          code === "SETTLEMENT_QUOTE_EXPIRED"
            ? "Checkout quote expired. Refresh the listing to get a new quote."
            : "Checkout quote is invalid or already used."
        );
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
      await appendCriticalMutation({
        db,
        operationId: `purchase.confirmed:${String(result.insertedId)}`,
        actor: buyerAddress,
        action: 'purchase.payment_confirmed',
        target: { type: 'purchase', id: String(result.insertedId) },
        reason: 'Confirmed checkout payment',
        before: { status: null },
        after: { status: purchaseRecord.status, amount: purchaseRecord.amount, asset: purchaseRecord.asset, materialId },
        intent: { materialId, paymentCompleted: true, quoteId: quote?.quoteId || null },
      });
    }

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
    return renderErrorResponse(
      isAppError(err)
        ? err
        : new AppError("INTERNAL", { cause: err }),
      { request: req, legacyError: "Server error" }
    );
  }
}

export const POST = withTelemetryRoute('purchase.complete', ACTOR_TYPES.USER, handlePost);
