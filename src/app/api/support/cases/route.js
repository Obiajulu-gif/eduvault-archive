import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';
import { requireActiveUser } from '@/lib/api/auth';
import { appendCaseEvent, createCase, readCase } from '@/lib/backend/supportTimeline';
import { TrustError } from '@/lib/backend/trustRecords';
import { withApiHardening } from '@/lib/api/hardening';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handle(request, write) {
  const auth = await requireActiveUser(request);
  if (!auth.ok) return NextResponse.json({ error: 'Unauthorized' }, { status: auth.status });
  try {
    const db = await getDb();
    const body = write ? await request.json() : {};
    const args = { ...body, db, user: auth.user };
    const result = write ? (body.id ? await appendCaseEvent(args) : await createCase(args))
      : await readCase({ db, user: auth.user, id: new URL(request.url).searchParams.get('id') });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof TrustError ? error.code : 'SUPPORT_UNAVAILABLE' },
      { status: error instanceof TrustError ? error.status : 503 });
  }
}
const guarded = (request, write) => withApiHardening(request,
  { route: 'support-cases', rateLimit: { limit: 30, windowMs: 60_000 } }, () => handle(request, write));
export const GET = request => guarded(request, false);
export const POST = request => guarded(request, true);
