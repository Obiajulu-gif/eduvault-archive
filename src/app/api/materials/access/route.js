import { getMaterialAccessStatus, createPendingAccessRequest } from "../../../../lib/purchases/access.js";

export const dynamic = 'force-dynamic';

export async function accessStatus(db, materialId, buyerAddress) {
  return getMaterialAccessStatus(db, materialId, buyerAddress);
}

/**
 * GET /api/materials/access?materialId=&buyerAddress=
 * Returns a simple access status for a material for a buyer.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const materialId = searchParams.get('materialId') || '';
    const buyerAddress = searchParams.get('buyerAddress') || '';

    if (!materialId || !buyerAddress) {
      const { NextResponse } = await import('next/server');
      return NextResponse.json({ error: 'Missing materialId or buyerAddress' }, { status: 400 });
    }

    const { getDb } = await import('../../../../lib/mongodb.js');
    const db = await getDb();
    const result = await accessStatus(db, materialId, buyerAddress);
    const { NextResponse } = await import('next/server');

    if (result?.statusCode) {
      return NextResponse.json({ error: result.error }, { status: result.statusCode });
    }
    return NextResponse.json(result);
  } catch (err) {
    const { NextResponse } = await import('next/server');
    return NextResponse.json({ error: 'Failed to determine access status', detail: String(err?.message || err) }, { status: 500 });
  }
}

/**
 * POST /api/materials/access
 * Starts a learner access request without granting access. Payment completion
 * must be recorded separately through /api/purchase.
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const materialId = body?.materialId || '';
    const buyerAddress = body?.buyerAddress || '';

    if (!materialId || !buyerAddress) {
      const { NextResponse } = await import('next/server');
      return NextResponse.json({ error: 'Missing materialId or buyerAddress' }, { status: 400 });
    }

    const { getDb } = await import('../../../../lib/mongodb.js');
    const db = await getDb();
    const result = await createPendingAccessRequest(db, materialId, buyerAddress, body);
    const { NextResponse } = await import('next/server');

    if (result?.statusCode) {
      return NextResponse.json({ error: result.error }, { status: result.statusCode });
    }

    return NextResponse.json(result, { status: result.hasAccess ? 200 : 202 });
  } catch (err) {
    const { NextResponse } = await import('next/server');
    return NextResponse.json({ error: 'Failed to start access request', detail: String(err?.message || err) }, { status: 500 });
  }
}
