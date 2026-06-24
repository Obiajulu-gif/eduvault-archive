export const dynamic = "force-dynamic";

import { getDb } from '@/lib/mongodb'
import { NextResponse } from 'next/server'
import { getUserFromCookie } from "@/lib/api/auth";
import {
  getMaterialAccessStatus,
  isCompletedPurchaseStatus,
  normalizeBuyerAddress,
} from "@/lib/purchases/access";

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

    const { materialId, signedXdr, email, transactionHash, amount, asset, buyerAddress: bodyBuyerAddress } = body;
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

    // Prevent duplicate purchases
    const existing = await db
      .collection('purchases')
      .findOne({ buyerAddress, materialId });
    if (existing) {
      if (isCompletedPurchaseStatus(existing.status)) {
        const access = await getMaterialAccessStatus(db, materialId, buyerAddress);
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
      return NextResponse.json(
        { success: true, purchaseId: existing._id, purchase, access, transactionHash: purchase?.transactionHash },
        { status: 200 }
      );
    }

    const now = new Date();

    const purchaseRecord = {
      materialId,
      buyerAddress,
      userEmail: email || null,
      status: paymentCompleted ? 'confirmed' : 'pending',
      transactionHash: transactionHash || null,
      signedXdr: signedXdr || null,
      amount: amount ?? null,
      asset: asset || null,
      purchasedAt: paymentCompleted ? now : null,
      confirmedAt: paymentCompleted ? now : null,
      createdAt: now,
      updatedAt: now,
    };

    const result = await db.collection('purchases').insertOne(purchaseRecord);
    const access = await getMaterialAccessStatus(db, materialId, buyerAddress);

    return NextResponse.json(
      { success: paymentCompleted, purchaseId: result.insertedId, purchase: { ...purchaseRecord, _id: result.insertedId }, access },
      { status: paymentCompleted ? 201 : 202 }
    );
  } catch (err) {
    console.error("POST /api/purchase error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
