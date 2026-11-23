export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api/auth';
import { getDb } from '@/lib/mongodb';
import {
  DESTRUCTIVE_ACTION,
  previewDestructiveAction,
  assertPreviewFingerprintValid,
  DryRunAuthError,
  DryRunValidationError,
  DryRunFingerprintMismatchError,
} from '@/lib/admin/dryRunPreview';

/**
 * POST /api/admin/dry-run
 *
 * Returns a read-only preview of a destructive maintainer action.
 * Pass `commit: true` together with the `fingerprint` from a prior preview
 * call to validate that the state has not drifted before allowing the actual
 * commit route to proceed.
 *
 * Request body:
 * {
 *   actionType: "BULK_CONTENT_REMOVE" | "BULK_ENTITLEMENT_REVOKE" | "USER_SUSPENSION"
 *             | "DATA_PURGE" | "MATERIAL_UNPUBLISH" | "CREATOR_DEACTIVATION",
 *   params: { ... action-specific parameters ... },
 *   commit?: boolean,          // validate fingerprint; does NOT commit data
 *   fingerprint?: string       // required when commit=true
 * }
 *
 * Response (preview):
 * {
 *   dryRun: true,
 *   actionType: string,
 *   fingerprint: string,
 *   affectedCount: number,
 *   risk: { level: "none"|"medium"|"high"|"critical", description: string },
 *   plan: [ { id, collection, action, fields, sideEffects, rollback } ],
 *   generatedAt: string
 * }
 *
 * Response (fingerprint validation):
 * {
 *   valid: true,
 *   fingerprint: string
 * }
 */
export async function POST(request) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized. Admin access required.' }, { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { actionType, params = {}, commit = false, fingerprint: storedFingerprint } = body;

  if (!actionType) {
    return NextResponse.json({ error: 'actionType is required.' }, { status: 400 });
  }

  if (!DESTRUCTIVE_ACTION[actionType]) {
    return NextResponse.json(
      {
        error: `Unknown actionType "${actionType}".`,
        validTypes: Object.keys(DESTRUCTIVE_ACTION),
      },
      { status: 400 },
    );
  }

  const principal = {
    id: admin.walletAddress || admin.sub,
    role: admin.role ?? 'admin',
  };

  try {
    // Fingerprint validation mode — does not change data, only checks drift
    if (commit) {
      if (!storedFingerprint) {
        return NextResponse.json(
          { error: 'fingerprint is required when commit=true.' },
          { status: 400 },
        );
      }

      const db = await getDb();
      await assertPreviewFingerprintValid(storedFingerprint, actionType, params, db);

      return NextResponse.json({ valid: true, fingerprint: storedFingerprint });
    }

    // Preview mode (default) — always read-only
    const db = await getDb().catch(() => null);
    const preview = await previewDestructiveAction({
      actionType,
      params,
      principal,
      db,
      authorize: async (p) => p?.role === 'admin' || p?.role === 'superadmin',
    });

    return NextResponse.json(preview);
  } catch (error) {
    if (error instanceof DryRunAuthError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 403 });
    }
    if (error instanceof DryRunValidationError) {
      return NextResponse.json({ error: error.message, code: error.code, details: error.details }, { status: 400 });
    }
    if (error instanceof DryRunFingerprintMismatchError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          expected: error.expected,
          actual: error.actual,
        },
        { status: 409 },
      );
    }

    console.error('POST /api/admin/dry-run error:', error);
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
