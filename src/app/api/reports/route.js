import { NextResponse } from 'next/server';
import { withApiHardening } from '@/lib/api/hardening';
import { createReport } from '@/lib/moderation/cases';
import { auditLog } from '@/lib/api/audit';

export async function POST(request) {
  return withApiHardening(
    request,
    { route: 'reports', rateLimit: { limit: 5, windowMs: 60000 } },
    async (req, res, session) => {
      try {
        const data = await request.json();
        
        if (!data.materialId || !data.reason) {
          auditLog({ event: 'report_validation_failed', status: 400, reason: 'Missing materialId or reason' });
          return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        // Ideally we'd get reporterId from the session, for now we assume it's passed or available
        const reporterId = session?.user?.id || data.reporterId || 'anonymous';
        
        const result = await createReport({
          materialId: data.materialId,
          reporterId,
          reason: data.reason,
          evidence: data.evidence
        });

        if (!result.success) {
          auditLog({ event: 'report_creation_failed', materialId: data.materialId, reason: result.message });
          // Returning 409 Conflict if duplicate report
          return NextResponse.json({ error: result.message }, { status: 409 });
        }

        auditLog({ event: 'report_submitted', materialId: data.materialId, reportId: result.reportId });
        return NextResponse.json({ success: true, reportId: result.reportId }, { status: 201 });
      } catch (err) {
        console.error('Report submission error:', err);
        auditLog({ event: 'report_submission_error', status: 500, reason: err.message });
        return NextResponse.json({ error: 'Failed to submit report' }, { status: 500 });
      }
    }
  );
}
