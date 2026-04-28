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

  try {
    // Note: Change to mainnet URL if deployed to mainnet
    const response = await fetch(`https://horizon-testnet.stellar.org/transactions/${txHash}`);
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

export async function GET(req) {
  try {
    const verification = await getUserFromCookie(req);
    if (!verification || !verification.valid) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = await getDb();
    const userAddress = verification.payload.walletAddress;

    const url = new URL(req.url);
    const page = parseInt(url.searchParams.get('page')) || 1;
    const limit = parseInt(url.searchParams.get('limit')) || 10;
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

    return NextResponse.json({
      data: enrichedRecords,
      pagination: {
        total: totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit)
      }
    });

  } catch (error) {
    console.error('Purchase List Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}