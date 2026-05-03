export const dynamic = "force-dynamic";

import { getDb } from '@/lib/mongodb'
import { NextResponse } from 'next/server'
import { verifyDashboardToken } from "@/lib/auth/session";

async function getUserFromCookie(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const cookieMatch = cookieHeader.match(/auth_token=([^;]+)/);
  const token = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
  if (!token) return null;
  return await verifyDashboardToken(token, process.env.JWT_SECRET);
}

export async function GET(req) {
  try {
    const verification = await getUserFromCookie(req);
    if (!verification || !verification.valid) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = await getDb();
    const userAddress = verification.payload.walletAddress;

    const purchases = await db
      .collection('purchases')
      .find({ buyerAddress: userAddress })
      .sort({ purchasedAt: -1 })
      .toArray();

    return NextResponse.json(purchases);
  } catch (error) {
    console.error('Purchase List Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { buyerAddress, materialId, transactionHash } = await req.json()

    if (!buyerAddress || !materialId || !transactionHash) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      )
    }

    const db = await getDb()

    // 1. Verify the transaction (Prototype Scope)
    // In a production environment, you would query the Stellar Horizon API here
    // using the transactionHash to verify that the exact required XLM/USDC
    // was transferred to the seller's address before granting access.

    // For this prototype, we treat the submitted hash as proof-of-payment.

    // 2. Record the entitlement
    const purchaseRecord = {
      buyerAddress,
      materialId,
      transactionHash,
      purchasedAt: new Date(),
      status: 'confirmed',
    }

    // Prevent duplicate purchases
    const existing = await db
      .collection('purchases')
      .findOne({ buyerAddress, materialId })
    if (existing) {
      return NextResponse.json(
        { message: 'Already purchased', purchase: existing },
        { status: 200 }
      )
    }

    const result = await db.collection('purchases').insertOne(purchaseRecord)

    return NextResponse.json(
      { success: true, purchaseId: result.insertedId },
      { status: 201 }
    )
  } catch (error) {
    console.error('Purchase Error:', error)
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    )
  }
}
