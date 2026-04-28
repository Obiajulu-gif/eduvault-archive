import { getDb } from '@/lib/mongodb'
import { NextResponse } from 'next/server'
import { auditLog } from "@/lib/api/audit";
import { checkRateLimit } from "@/lib/api/rateLimit";
import { captureException } from "@/lib/sentry";

const ENTITLEMENT_RATE_LIMIT = { limit: 60, windowMs: 60_000 };

function clientKey(request) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  return (
    forwardedFor?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "local"
  );
}

export async function GET(req) {
  // Apply rate limiting
  const rateLimitKey = `entitlements:GET:${clientKey(req)}`;
  const rateLimit = checkRateLimit(rateLimitKey, ENTITLEMENT_RATE_LIMIT);

  if (!rateLimit.allowed) {
    auditLog({
      event: "rate_limit_blocked",
      route: "entitlements",
      method: "GET",
      status: 429,
      clientKey: clientKey(req),
    });
    return NextResponse.json(
      { error: "Too many requests", retryAfter: rateLimit.retryAfter },
      { status: 429 }
    );
  }

  try {
    const { searchParams } = new URL(req.url)
    const buyerAddress = searchParams.get('buyerAddress')
    const materialId = searchParams.get('materialId')

    if (!buyerAddress || !materialId) {
      return NextResponse.json(
        { error: 'Missing buyerAddress or materialId' },
        { status: 400 }
      )
    }

    const db = await getDb()

    const entitlement = await db
      .collection('purchases')
      .findOne({ buyerAddress, materialId })

    if (entitlement && entitlement.status === 'confirmed') {
      return NextResponse.json(
        { hasAccess: true, entitlement },
        { status: 200 }
      )
    } else {
      return NextResponse.json({ hasAccess: false }, { status: 200 })
    }
  } catch (error) {
    console.error('Entitlement Check Error:', error)
    captureException(error, { route: "entitlements", method: "GET" });
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    )
  }
}
