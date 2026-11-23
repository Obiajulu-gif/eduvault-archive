import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';
import { requirePermission } from '@/lib/api/auth';
import { resolveFraudReview } from '@/lib/backend/fraudReview';
import { TrustError } from '@/lib/backend/trustRecords';
import { withApiHardening } from '@/lib/api/hardening';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handle(request, resolve) {
  const auth = await requirePermission(request, 'admin:access');
  if (!auth.ok) return NextResponse.json({ error: 'Forbidden' }, { status: auth.status });
  try {
    const db = await getDb();
    const id = new URL(request.url).searchParams.get('id');
    const result = resolve ? await resolveFraudReview({ ...(await request.json()), db, user: auth.user })
      : id ? await db.collection('fraud_reviews').findOne({ _id: id })
        : await db.collection('fraud_reviews').find({ state: 'pending' })
          .sort({ createdAt: 1, _id: 1 }).limit(100).toArray();
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof TrustError ? error.code : 'REVIEW_UNAVAILABLE' },
      { status: error instanceof TrustError ? error.status : 503 });
  }
}
const guarded = (request, resolve) => withApiHardening(request,
  { route: 'fraud-reviews', rateLimit: { limit: 60, windowMs: 60_000 } }, () => handle(request, resolve));
export const GET = request => guarded(request, false);
export const POST = request => guarded(request, true);
