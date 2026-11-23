export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api/auth';
import { exportConfigAuditBundle } from '@/lib/config/adminConfigAudit';

/**
 * GET /api/admin/config/evidence
 * Exports verifiable configuration change audit evidence bundles for compliance,
 * support investigations, or security forensics.
 *
 * Query Parameters:
 * - settingKey: optional string filter
 * - category: optional category filter
 * - actorId: optional admin actor filter
 * - from: optional ISO date filter
 * - to: optional ISO date filter
 * - limit: optional integer (default 1000, max 5000)
 */
export async function GET(request) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const filter = {};

    const settingKey = searchParams.get('settingKey');
    if (settingKey) filter.settingKey = settingKey;

    const category = searchParams.get('category');
    if (category) filter.category = category;

    const actorId = searchParams.get('actorId');
    if (actorId) filter.actorId = actorId;

    const from = searchParams.get('from');
    if (from) filter.from = from;

    const to = searchParams.get('to');
    if (to) filter.to = to;

    const limit = searchParams.get('limit');
    if (limit) filter.limit = Number(limit);

    const bundle = await exportConfigAuditBundle({
      filter,
      requestedBy: admin,
    });

    return NextResponse.json(bundle, { status: 200 });
  } catch (error) {
    console.error('GET /api/admin/config/evidence error:', error);
    return NextResponse.json({ error: 'Failed to export configuration audit evidence bundle.' }, { status: 500 });
  }
}
