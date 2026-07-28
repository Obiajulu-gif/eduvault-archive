import { NextResponse } from 'next/server';
import { withApiHardening } from '@/lib/api/hardening';
import { getDb } from '@/lib/mongodb';
import { proposeSanction, approveSanction, fileAppeal, resolveAppeal } from '@/lib/moderation/cases';
import { auditLog } from '@/lib/api/audit';

export async function GET(request) {
  return withApiHardening(
    request,
    { route: 'admin-moderation-list' },
    async (req, res, session) => {
      // In a real app, verify admin role here
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
    async (req, res, session) => {
      // In a real app, verify admin role here
      try {
        const data = await request.json();
        const { action, caseId, sanction, decision, reason } = data;
        const actorId = session?.user?.id || data.actorId || 'admin_user';

        let result;
        switch (action) {
          case 'propose':
            if (!sanction) throw new Error('Missing sanction');
            result = await proposeSanction(caseId, sanction, actorId);
            break;
          case 'approve':
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

        return NextResponse.json(result);
      } catch (err) {
        console.error('Moderation action error:', err);
        auditLog({ event: 'moderation_action_error', status: 500, reason: err.message });
        return NextResponse.json({ error: err.message }, { status: 400 }); // Return 400 for logic errors
      }
    }
  );
}
