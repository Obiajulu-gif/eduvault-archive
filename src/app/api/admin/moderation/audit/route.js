import { NextResponse } from 'next/server';
import { withApiHardening } from '@/lib/api/hardening';
import { getDb } from '@/lib/mongodb';
import { auditLog } from '@/lib/api/audit';

export async function GET(request) {
  return withApiHardening(
    request,
    { route: 'admin-moderation-audit-export' },
    async (req, res, session) => {
      // In a real app, verify admin/auditor role here
      try {
        const db = await getDb();
        const cases = db.collection('moderation_cases');
        const reports = db.collection('moderation_reports');
        
        // Fetch all cases
        const caseList = await cases.find({}).sort({ createdAt: -1 }).toArray();

        // Fetch reports but scrub private data
        const reportList = await reports.find({}).project({ reporterId: 0 }).toArray();

        const exportData = {
          cases: caseList,
          reports: reportList,
          exportedAt: new Date().toISOString()
        };

        auditLog({ event: 'audit_exported', actorId: session?.user?.id || 'admin_user' });

        return NextResponse.json(exportData);
      } catch (err) {
        console.error('Audit export error:', err);
        return NextResponse.json({ error: 'Failed to export audit data' }, { status: 500 });
      }
    }
  );
}
