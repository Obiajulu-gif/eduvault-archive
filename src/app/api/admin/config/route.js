export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongodb';
import { requireAdmin } from '@/lib/api/auth';
import {
  CONFIG_SETTING_REGISTRY,
  ConfigAuditError,
  applyAdminConfigChange,
  verifyConfigAuditChain,
} from '@/lib/config/adminConfigAudit';
import { COLLECTIONS } from '@/lib/backend/schemaContracts';

/**
 * GET /api/admin/config
 * Returns active administrative configuration settings, recent audit evidence records,
 * and current hash chain verification status.
 */
export async function GET(request) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 });
  }

  try {
    const db = await getDb();
    const configCol = db.collection(COLLECTIONS.systemConfig || 'system_config');
    const evidenceCol = db.collection(COLLECTIONS.configAuditEvidence || 'config_audit_evidence');

    const [storedConfigs, recentEvidence, allEvidence] = await Promise.all([
      configCol.find({}).toArray(),
      evidenceCol.find({}).sort({ sequence: -1 }).limit(20).toArray(),
      evidenceCol.find({}).sort({ sequence: 1 }).toArray(),
    ]);

    // Merge stored configurations with default registry values
    const activeConfig = {};
    for (const [key, meta] of Object.entries(CONFIG_SETTING_REGISTRY)) {
      activeConfig[key] = meta.defaultValue;
    }
    for (const doc of storedConfigs) {
      activeConfig[doc._id] = doc.value;
    }

    const chainVerification = verifyConfigAuditChain(allEvidence);

    return NextResponse.json({
      success: true,
      activeConfig,
      registeredSettings: CONFIG_SETTING_REGISTRY,
      recentEvidence,
      totalEvidenceCount: allEvidence.length,
      chainVerification,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('GET /api/admin/config error:', error);
    return NextResponse.json({ error: 'Failed to retrieve configuration and audit trail.' }, { status: 500 });
  }
}

/**
 * POST /api/admin/config
 * Applies an administrative configuration change with full audit evidence.
 *
 * Request Body:
 * {
 *   settingKey: string,
 *   value: any,
 *   reason: string (min 5 chars),
 *   operationId?: string,
 *   approvalEvidence?: { approver: string, reason?: string, approvalToken?: string }
 * }
 */
export async function POST(request) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const { settingKey, value, reason, operationId, approvalEvidence } = body;

    const opId = operationId || request.headers.get('x-idempotency-key') || undefined;

    const result = await applyAdminConfigChange({
      operationId: opId,
      settingKey,
      proposedValue: value,
      actor: admin,
      reason,
      approvalEvidence,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof ConfigAuditError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          details: error.details,
        },
        { status: error.status || 400 }
      );
    }

    console.error('POST /api/admin/config error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
