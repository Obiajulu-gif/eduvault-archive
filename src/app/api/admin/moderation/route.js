export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { withApiHardening } from '@/lib/api/hardening';
import { getDb } from '@/lib/mongodb';
import { requireAdmin } from '@/lib/api/auth';
import { proposeSanction, approveSanction, fileAppeal, resolveAppeal } from '@/lib/moderation/cases';
import { auditLog } from '@/lib/api/audit';
import { appendAuditRecord } from '@/lib/backend/auditLedger';

export async function GET(request) {
  return withApiHardening(
    request,
    { route: 'admin-moderation-list' },
    async () => {
      const admin = await requireAdmin(request);
      if (!admin) {
        return NextResponse.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 });
      }

      const db = await getDb();
      const cases = db.collection('moderation_cases');
      
      const { searchParams } = new URL(request.url);
      const status = searchParams.get('status');
      
      const query = status ? { status } : {};
      const caseList = await cases.find(query).sort({ createdAt: -1 }).toArray();

      return NextResponse.json({ cases: caseList });
    }
  );
}

export async function POST(request) {
  return withApiHardening(
    request,
    { route: 'admin-moderation-action' },
    async () => {
      const admin = await requireAdmin(request);
      if (!admin) {
        return NextResponse.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 });
      }

      let db;
      let actorId;
      let operationId;
      let action;
      let caseId;
      try {
        const data = await request.json();
        ({ action, caseId } = data);
        const { sanction, decision, reason } = data;
        actorId = admin.walletAddress || admin.sub || data.actorId;
        operationId = request.headers.get('x-idempotency-key') || `${action}:${caseId}:${actorId}`;
        db = await getDb();

        let result;
        switch (action) {
          case 'propose':
            if (!sanction) throw new Error('Missing sanction');
            result = await proposeSanction(caseId, sanction, actorId);
            break;
          case 'approve':
            if (!approveSanction) throw new Error('Missing approve handler');
            result = await approveSanction(caseId, actorId);
            break;
          case 'file_appeal':
            if (!reason) throw new Error('Missing appeal reason');
            result = await fileAppeal(caseId, actorId, reason);
            break;
          case 'resolve_appeal':
            if (!decision) throw new Error('Missing appeal decision');
            result = await resolveAppeal(caseId, decision, actorId);
            break;
          default:
            return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
        }

        await appendAuditRecord({
          db,
          operationId,
          actor: actorId,
          action: `moderation.${action}`,
          target: { type: 'moderation_case', id: String(caseId) },
          intent: { action, sanction, decision, reason },
          result: { success: true },
          reason,
        });

        return NextResponse.json(result);
      } catch (err) {
        console.error('Moderation action error:', err);
        auditLog({ event: 'moderation_action_error', status: 500, reason: err.message });
        if (db && action && caseId && actorId) {
          await appendAuditRecord({
            db,
            operationId: `${operationId}:failed`,
            actor: actorId,
            action: `moderation.${action}.failed`,
            target: { type: 'moderation_case', id: String(caseId) },
            intent: { action },
            result: { success: false, error: err.message },
            reason: err.message,
          });
        }
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
    }
  );
}
