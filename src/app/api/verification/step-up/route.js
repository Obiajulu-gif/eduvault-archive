import { NextResponse } from 'next/server';
import { Keypair } from '@stellar/stellar-sdk';
import { getDb } from '@/lib/mongodb';
import { requireActiveUser } from '@/lib/api/auth';
import { withApiHardening } from '@/lib/api/hardening';
import { startStepUp, verifyStepUp } from '@/lib/backend/stepUpVerification';
import { TrustError } from '@/lib/backend/trustRecords';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request) {
  return withApiHardening(request, { route: 'step-up', rateLimit: { limit: 10, windowMs: 60_000 } }, async () => {
    const auth = await requireActiveUser(request);
    if (!auth.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: auth.status });
    try {
      const body = await request.json();
      const db = await getDb();
      const result = body.id ? await verifyStepUp({ db, user: auth.user, id: body.id, signature: body.signature,
        verifySignature: (wallet, message, signature) => Keypair.fromPublicKey(wallet)
          .verify(Buffer.from(message, 'utf8'), Buffer.from(signature, 'base64')) })
        : await startStepUp({ db, user: auth.user, binding: body.binding || {} });
      return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      return NextResponse.json({ error: error instanceof TrustError ? error.code : 'VERIFICATION_UNAVAILABLE' },
        { status: error instanceof TrustError ? error.status : 503 });
    }
  });
}
