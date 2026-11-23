import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';
import { requireActiveUser } from '@/lib/api/auth';
import { consentHistory, POLICIES, recordConsent } from '@/lib/backend/consentLedger';
import { digest, TrustError } from '@/lib/backend/trustRecords';
import { withApiHardening } from '@/lib/api/hardening';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handle(request, write) {
  const auth = await requireActiveUser(request);
  if (!auth.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: auth.status });
  try {
    const db = await getDb();
    const policyKey = new URL(request.url).searchParams.get('policy') || 'catalog-management:1';
    const body = write ? await request.json() : null;
    const result = write ? await recordConsent({ db, user: auth.user, policyKey: body.policyKey,
      versionHash: body.versionHash, decision: body.decision, source: 'account-api' })
      : { policies: Object.entries(POLICIES).map(([key, policy]) => ({ key, ...policy, versionHash: digest(policy) })),
        history: await consentHistory({ db, user: auth.user, policyKey }) };
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof TrustError ? error.code : 'CONSENT_UNAVAILABLE' },
      { status: error instanceof TrustError ? error.status : 503 });
  }
}
const guarded = (request, write) => withApiHardening(request,
  { route: 'consent', rateLimit: { limit: 30, windowMs: 60_000 } }, () => handle(request, write));
export const GET = request => guarded(request, false);
export const POST = request => guarded(request, true);
