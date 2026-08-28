export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { getUserFromCookie } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { sendReceiptIfEligible } from "@/lib/email";
import { errorResponse } from "@/lib/utils/errorResponse";
import logger from "@/lib/logger";

/**
 * POST /api/email/purchase-receipt
 *
 * Triggers (or retries) sending a purchase-receipt email for a given purchase.
 * The endpoint resolves the buyer email from the purchase record (or the
 * linked user profile), fetches the material metadata, and enqueues the
 * receipt through the transactional side-effect outbox so delivery is
 * guaranteed with bounded retries.
 *
 * Accepts JSON body: { purchaseId: string }
 * Requires authentication.
 */
export async function POST(request) {
  return withApiHardening(
    request,
    { route: "email/purchase-receipt", rateLimit: { limit: 20, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user) {
        return errorResponse({
          status: 401,
          detail: "Authentication required",
          instance: "/api/email/purchase-receipt",
        });
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse({
          status: 400,
          detail: "Invalid JSON body",
          instance: "/api/email/purchase-receipt",
        });
      }

      const { purchaseId } = body || {};

      if (!purchaseId || typeof purchaseId !== "string") {
        return errorResponse({
          status: 400,
          detail: "Missing or invalid purchaseId",
          instance: "/api/email/purchase-receipt",
        });
      }

      if (!ObjectId.isValid(purchaseId)) {
        return errorResponse({
          status: 400,
          detail: "purchaseId must be a valid 24-character hex ObjectId",
          instance: "/api/email/purchase-receipt",
        });
      }

      const db = await getDb();

      const purchase = await db
        .collection("purchases")
        .findOne({ _id: new ObjectId(purchaseId) });

      if (!purchase) {
        return errorResponse({
          status: 404,
          detail: "Purchase not found",
          instance: "/api/email/purchase-receipt",
        });
      }

      const completedStatuses = ["confirmed", "settled", "completed"];
      if (!completedStatuses.includes(purchase.status)) {
        return errorResponse({
          status: 400,
          detail: `Purchase status "${purchase.status}" is not eligible for a receipt email. Must be one of: ${completedStatuses.join(", ")}`,
          instance: "/api/email/purchase-receipt",
        });
      }

      if (purchase.receiptSent) {
        return NextResponse.json({
          success: true,
          message: "Receipt already sent for this purchase",
          purchaseId,
        });
      }

      try {
        await sendReceiptIfEligible(db, purchaseId);

        logger.info(
          { purchaseId, buyerAddress: purchase.buyerAddress },
          "Purchase receipt email enqueued",
        );

        return NextResponse.json({
          success: true,
          message: "Receipt email enqueued for delivery",
          purchaseId,
        });
      } catch (err) {
        logger.error({ err, purchaseId }, "Failed to enqueue purchase receipt email");
        return errorResponse({
          status: 500,
          detail: "Failed to enqueue receipt email",
          instance: "/api/email/purchase-receipt",
        });
      }
    }
  );
}
