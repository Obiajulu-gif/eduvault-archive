export const dynamic = "force-dynamic";

import { ObjectId } from "mongodb";
import { getDb, getMongoClientPromise as getClientPromise } from '@/lib/mongodb';
import { NextResponse } from 'next/server';
import { getUserFromCookie } from "@/lib/api/auth";
import { findMaterial } from "@/lib/checkout/discountVerifier";
import {
  CheckoutIntentError,
  CHECKOUT_INTENT_ERROR_CODES,
  assertCheckoutIntentMatches,
  assertMaterialStillMatchesIntent,
} from "@/lib/checkout/intent";
import { PURCHASE_MANAGER_CONTRACT_ID } from "@/lib/config/chain";
import { createEntitlement } from "@/lib/entitlement";

import {
  getMaterialAccessStatus,
  isCompletedPurchaseStatus,
  normalizeBuyerAddress,
} from "@/lib/purchases/access";
import { verifyPurchaseTransaction, PurchaseVerificationError } from "@/lib/purchases/chainVerifier";
import { PURCHASE_STATES } from "@/lib/purchases/stateMachine";
import { getLatestManifest } from "@/lib/provenance/registry";
import { insertOutboxEvent, OUTBOX_EVENT_TYPES } from "@/lib/outbox";

const STELLAR_NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK || "TESTNET";

function jsonError(error) {
  return NextResponse.json(
    { error: error.message, code: error.code || "checkout_error" },
    { status: error.status || 422 },
  );
}

function toObjectId(value) {
  try {
    return new ObjectId(String(value));
  } catch {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.TAMPERED,
      "A valid checkout intent id is required",
      400,
    );
  }
}

async function resolveVersionBinding(materialId) {
  try {
    const latestManifest = await getLatestManifest(materialId);
    if (!latestManifest) return { latestManifest: null, versionBinding: null };

    return {
      latestManifest,
      versionBinding: {
        version: latestManifest.version,
        manifestDigest: latestManifest.digest,
        fileCid: latestManifest.manifest?.file?.cid || null,
        fileHash: latestManifest.manifest?.file?.hash || null,
        boundAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    console.warn("[purchase] Failed to resolve version binding:", error?.message);
    return { latestManifest: null, versionBinding: null };
  }
}

async function loadAndValidateIntent({ db, body, materialId, buyerAddress }) {
  const intentId = toObjectId(body.checkoutIntentId || body.checkoutId);
  const storedIntent = await db.collection("checkout_intents").findOne({ _id: intentId });

  if (!storedIntent) {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.TAMPERED,
      "Checkout intent was not found",
      404,
    );
  }

  if (storedIntent.status === "consumed") {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.CONSUMED,
      "Checkout intent has already been consumed",
      409,
    );
  }

  const intent = {
    terms: storedIntent.terms,
    intentHash: storedIntent.intentHash,
    signature: storedIntent.signature,
    signatureAlg: storedIntent.signatureAlg,
  };

  if (body.checkoutIntentSignature && body.checkoutIntentSignature !== intent.signature) {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.TAMPERED,
      "Checkout intent signature does not match the stored intent",
      422,
    );
  }

  assertCheckoutIntentMatches({
    intent,
    buyerAddress,
    materialId,
    network: STELLAR_NETWORK,
    contractId: PURCHASE_MANAGER_CONTRACT_ID,
  });

  const material = await findMaterial(materialId, db);
  if (!material) {
    throw new CheckoutIntentError(
      CHECKOUT_INTENT_ERROR_CODES.CHANGED,
      "Material is no longer available for checkout",
      409,
    );
  }

  const { latestManifest, versionBinding } = await resolveVersionBinding(materialId);
  assertMaterialStillMatchesIntent({
    intent,
    material,
    materialVersion: latestManifest?.version || null,
    manifestDigest: latestManifest?.digest || null,
  });

  return { intentId, storedIntent, intent, material, versionBinding };
}

function buildPurchaseFields({ body, intent, versionBinding, chainReceipt }) {
  const now = new Date();
  return {
    status: PURCHASE_STATES.CONFIRMED,
    transactionHash: body.transactionHash,
    chainReceipt: {
      ...chainReceipt,
      intentHash: intent.intentHash,
      policyVersion: intent.terms.policyVersion,
    },
    signedXdr: body.signedXdr || null,
    amount: intent.terms.amount.units,
    amountDisplay: intent.terms.amount.display,
    amountDecimals: intent.terms.amount.decimals,
    asset: intent.terms.asset.contract || intent.terms.asset.code,
    assetDetails: intent.terms.asset,
    userEmail: body.email || null,
    checkoutIntent: {
      id: body.checkoutIntentId || body.checkoutId,
      hash: intent.intentHash,
      policyVersion: intent.terms.policyVersion,
      nonce: intent.terms.nonce,
      expiresAt: intent.terms.expiry,
      feeBreakdown: intent.terms.feeBreakdown,
    },
    purchasedVersion: versionBinding?.version || intent.terms.material.version || null,
    versionBinding,
    purchasedAt: now,
    confirmedAt: now,
    updatedAt: now,
  };
}

export async function GET(req) {
  try {
    const user = await getUserFromCookie(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
  let session = null;

  try {
    const user = await getUserFromCookie(req);
    const db = await getDb();
    const client = await getClientPromise();
    const body = await req.json();

    const { materialId, signedXdr, transactionHash, buyerAddress: bodyBuyerAddress } = body;
    const buyerAddress = normalizeBuyerAddress(
      user?.walletAddress || user?.address || user?.id || bodyBuyerAddress,
    );

    if (!materialId) {
      return NextResponse.json({ error: "Missing materialId" }, { status: 400 });
    }

    if (!buyerAddress) {
      return NextResponse.json(
        { error: user ? "Missing buyer address" : "Unauthorized" },
        { status: user ? 400 : 401 },
      );
    }

    if (!transactionHash) {
      return NextResponse.json(
        { error: "Finalized transaction hash is required", code: "missing_transaction_hash" },
        { status: 400 },
      );
    }

    if (signedXdr && !transactionHash) {
      return NextResponse.json(
        { error: "A signed envelope is not proof of settlement", code: "signed_xdr_only" },
        { status: 422 },
      );
    }

    const { intentId, storedIntent, intent, versionBinding } = await loadAndValidateIntent({
      db,
      body,
      materialId,
      buyerAddress,
    });

    const chainReceipt = await verifyPurchaseTransaction({
      transactionHash,
      buyerAddress,
      materialId,
      asset: intent.terms.asset.contract || intent.terms.asset.code,
      amount: intent.terms.amount.units,
    });

    session = client.startSession();
    let purchaseResponse;

    await session.withTransaction(async () => {
      const existing = await db.collection("purchases").findOne({ buyerAddress, materialId }, { session });

      if (existing && isCompletedPurchaseStatus(existing.status)) {
        await createEntitlement(materialId, buyerAddress, {
          purchaseId: String(existing._id),
          transactionHash: existing.transactionHash,
          session,
        });
        const access = await getMaterialAccessStatus(db, materialId, buyerAddress);
        purchaseResponse = {
          status: 200,
          body: {
            message: "Already purchased",
            purchase: existing,
            access,
            transactionHash: existing.transactionHash,
          },
        };
        return;
      }

      const consumeResult = await db.collection("checkout_intents").updateOne(
        {
          _id: intentId,
          status: "initiated",
          signature: storedIntent.signature,
          expiresAt: { $gt: new Date() },
        },
        {
          $set: {
            status: "consumed",
            consumedAt: new Date(),
            consumedBy: buyerAddress,
            transactionHash,
          },
        },
        { session },
      );

      if (consumeResult.modifiedCount !== 1) {
        const latest = await db.collection("checkout_intents").findOne({ _id: intentId }, { session });
        const code =
          latest?.status === "consumed"
            ? CHECKOUT_INTENT_ERROR_CODES.CONSUMED
            : CHECKOUT_INTENT_ERROR_CODES.EXPIRED;
        throw new CheckoutIntentError(code, "Checkout intent can no longer be used", 409);
      }

      const now = new Date();
      const purchaseFields = buildPurchaseFields({ body, intent, versionBinding, chainReceipt });

      let purchase;
      if (existing) {
        await db.collection("purchases").updateOne(
          { _id: existing._id },
          { $set: purchaseFields },
          { session },
        );
        purchase = await db.collection("purchases").findOne({ _id: existing._id }, { session });
      } else {
        purchase = {
          materialId,
          buyerAddress,
          createdAt: now,
          ...purchaseFields,
        };
        const result = await db.collection("purchases").insertOne(purchase, { session });
        purchase._id = result.insertedId;
      }

      await createEntitlement(materialId, buyerAddress, {
        purchaseId: String(purchase._id),
        transactionHash,
        amount: intent.terms.amount.units,
        asset: intent.terms.asset.contract || intent.terms.asset.code,
        session,
      });

      await insertOutboxEvent(db, session, {
        type: OUTBOX_EVENT_TYPES.SEND_PURCHASE_WEBHOOK,
        payload: {
          materialId,
          buyerAddress,
          amount: intent.terms.amount.units,
          asset: intent.terms.asset.contract || intent.terms.asset.code,
          transactionHash,
          checkoutIntentHash: intent.intentHash,
        },
        idempotencyKey: `webhook_${purchase._id}_${transactionHash}`,
      });

      const access = await getMaterialAccessStatus(db, materialId, buyerAddress);
      purchaseResponse = {
        status: existing ? 200 : 201,
        body: {
          success: true,
          purchaseId: purchase._id,
          purchase,
          access,
          transactionHash,
          checkoutIntentHash: intent.intentHash,
        },
      };
    });

    return NextResponse.json(purchaseResponse.body, { status: purchaseResponse.status });
  } catch (err) {
    if (err instanceof CheckoutIntentError || err instanceof PurchaseVerificationError) {
      return jsonError(err);
    }

    console.error("POST /api/purchase error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  } finally {
    if (session) {
      await session.endSession();
    }
  }
}
