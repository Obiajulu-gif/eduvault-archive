export const dynamic = "force-dynamic";

/**
 * Stellar payment-confirmation webhook / reconciliation job — Issue #418.
 *
 * Stellar and Soroban have no native mechanism to push a webhook to us when a
 * payment confirms, so "listen for payment confirmations from the Stellar
 * network" is implemented here as a POLLING job rather than an inbound webhook
 * endpoint: an external scheduler (cron, Vercel Cron, GitHub Action, uptime
 * pinger, etc.) invokes this route periodically. Each run scans purchases that
 * are still pending, checks their transaction hash against Horizon, and — for
 * any payment that has landed on-chain — flips the purchase to "confirmed" and
 * grants access using the exact same entitlement + side-effect logic as the
 * synchronous checkout path (POST /api/purchase).
 *
 * Because it is polling (not an inbound push), there is no attacker-controllable
 * payload to validate — the only untrusted input is the caller's identity, which
 * is gated by a shared secret when one is configured.
 */

import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { logger } from "@/lib/logger";
import { getTransactionStatus } from "@/lib/stellar/horizonClient";
import { createEntitlement } from "@/lib/entitlement";
import { broadcastPurchaseEvent } from "@/lib/webhooks/sender";
import { sendReceiptIfEligible } from "@/lib/email";
import { reconcilePendingPurchases } from "@/lib/purchases/paymentReconciler";

/**
 * Authorize the caller. If STELLAR_WEBHOOK_SECRET (or CRON_SECRET) is set, the
 * request must present it as a Bearer token or `?token=` query param. When no
 * secret is configured the route is open (local/dev convenience only).
 */
function isAuthorized(req) {
  const secret = process.env.STELLAR_WEBHOOK_SECRET || process.env.CRON_SECRET;
  if (!secret) return true;

  const authHeader = req.headers.get("authorization") || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  const token = bearer || new URL(req.url).searchParams.get("token");
  return token === secret;
}

async function handle(req) {
  if (!isAuthorized(req)) {
    logger.warn("Rejected unauthorized Stellar payment reconciliation request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = await getDb();

    const summary = await reconcilePendingPurchases({
      db,
      logger,
      getTransactionStatus,
      grantEntitlement: (materialId, buyerAddress, meta) =>
        createEntitlement(materialId, buyerAddress, meta),
      onConfirmed: async (purchase) => {
        // Reuse the synchronous path's side-effects: email receipt + creator webhook.
        sendReceiptIfEligible(db, purchase._id).catch((err) =>
          logger.error(`Receipt send failed for purchase ${purchase._id}: ${err.message}`)
        );
        broadcastPurchaseEvent(purchase.materialId, {
          buyerAddress: purchase.buyerAddress,
          amount: purchase.amount,
          asset: purchase.asset,
          transactionHash: purchase.transactionHash,
        });
      },
    });

    logger.info(`Stellar payment reconciliation run complete: ${JSON.stringify(summary)}`);
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    logger.error(`Stellar payment reconciliation failed: ${err.message}`);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

// Support both GET (simple cron pingers) and POST (schedulers that prefer POST).
export async function GET(req) {
  return handle(req);
}

export async function POST(req) {
  return handle(req);
}
