import { getDb } from '@/lib/mongodb';
import { NextResponse } from 'next/server';
import { verifyDashboardToken } from "@/lib/auth/session";

const horizonCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getUserFromCookie(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const cookieMatch = cookieHeader.match(/auth_token=([^;]+)/);
  const token = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
  if (!token) return null;
  return await verifyDashboardToken(token, process.env.JWT_SECRET);
}

async function getHorizonTransaction(txHash) {
  if (!txHash) return null;

  if (horizonCache.has(txHash)) {
    const cached = horizonCache.get(txHash);
    if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const HORIZON_BASE_URL = process.env.STELLAR_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';

  try {
    const response = await fetch(`${HORIZON_BASE_URL}/transactions/${txHash}`);

    if (!response.ok) return null;
    
    const data = await response.json();
    
    horizonCache.set(txHash, {
      timestamp: Date.now(),
      data: {
        successful: data.successful,
        fee_charged: data.fee_charged,
        created_at: data.created_at,
        memo: data.memo
      }
    });
    
    return horizonCache.get(txHash).data;
  } catch (error) {
    console.error(`Failed to fetch Horizon data for ${txHash}`, error);
    return null;
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

export async function GET(req) {
  try {
    const verification = await getUserFromCookie(req);
    if (!verification || !verification.valid) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = await getDb();
    const userAddress = verification.payload.walletAddress;

    const url = new URL(req.url);
    const rawPage = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
    const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '10', 10);
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10;
    const skip = (page - 1) * limit;

    const pipeline = [
      {
        $lookup: {
          from: 'materials',
          localField: 'materialId',
          foreignField: '_id',
          as: 'materialDetails'
        }
      },
      {
        $unwind: {
          path: '$materialDetails',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $match: {
          $or: [
            { buyerAddress: userAddress },
            { 'materialDetails.creatorAddress': userAddress }
          ]
        }
      },
      {
        $addFields: {
          type: {
            $cond: { if: { $eq: ['$buyerAddress', userAddress] }, then: 'purchase', else: 'sale' }
          }
        }
      },
      { $sort: { purchasedAt: -1 } },
      {
        $facet: {
          metadata: [{ $count: "total" }],
          data: [{ $skip: skip }, { $limit: limit }]
        }
      }
    ];

    const [result] = await db.collection('purchases').aggregate(pipeline).toArray();
    const records = result.data || [];
    const totalCount = result.metadata[0]?.total || 0;

    const enrichedRecords = await Promise.all(
      records.map(async (record) => {
        const horizonData = await getHorizonTransaction(record.transactionHash);
        return {
          ...record,
          onChainData: horizonData || null
        };
      })
    );

    const response = NextResponse.json(enrichedRecords);
    
    response.headers.set('X-Total-Count', totalCount.toString());
    response.headers.set('X-Total-Pages', Math.ceil(totalCount / limit).toString());
    response.headers.set('X-Current-Page', page.toString());
    response.headers.set('X-Per-Page', limit.toString());

    return response;

  } catch (error) {
    console.error('Purchase List Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}