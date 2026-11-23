export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { requireActiveUser, requireAdmin } from '@/lib/api/auth';
import { getDb } from '@/lib/mongodb';
import { appendJournalEntry } from '@/lib/backend/creatorJournal.js';
import { appendFinancialEvent } from '@/lib/backend/financialAuditLedger.js';
import {
  SettlementReconciliationError,
  reconcilePayoutSettlement,
} from '@/lib/payouts/settlementReconciliation.js';

const BAD_REQUEST_CODES = new Set([
  'INVALID_INPUT',
  'INVALID_EVENT',
  'INVALID_AMOUNT',
  'UNSAFE_AMOUNT',
  'AMOUNT_PRECISION_UNSUPPORTED',
]);

function actorFromAdmin(admin) {
  return {
    id: admin.walletAddress || admin.sub || admin.id,
    role: admin.role || 'admin',
  };
}

export async function POST(request) {
  const admin = await requireAdmin(request);
  if (!admin) {
    const active = await requireActiveUser(request);
    const authenticated = active.ok;
    return NextResponse.json(
      {
        error: authenticated ? 'Admin access required.' : 'Authentication required.',
        code: authenticated ? 'AUTH_FORBIDDEN' : 'AUTH_UNAUTHENTICATED',
      },
      { status: authenticated ? 403 : 401 }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.', code: 'INVALID_JSON' }, { status: 400 });
  }

  const payload = body && typeof body === 'object' ? body : {};
  const event = payload.event ?? payload;

  try {
    const db = await getDb();
    const result = await reconcilePayoutSettlement({
      db,
      event,
      actor: actorFromAdmin(admin),
      allowSystem: false,
      appendJournalEntryFn: appendJournalEntry,
      recordAuditFn: (audit) => appendFinancialEvent(db, {
        ...audit,
        timestamp: audit.timestamp || new Date(),
      }),
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SettlementReconciliationError) {
      const status = error.code === 'UNAUTHORIZED_RECONCILIATION'
        ? 403
        : BAD_REQUEST_CODES.has(error.code) ? 400 : 500;
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
        { status }
      );
    }

    console.error('POST /api/admin/payouts/reconcile error:', error);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
