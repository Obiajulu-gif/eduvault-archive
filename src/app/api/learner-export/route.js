/**
 * GET /api/learner-export
 *
 * Export learner library data with privacy-safe field-level authorization (#1017).
 * Supports subject learners, creators, customer support agents, external auditors,
 * and administrators with strict role-based masking, redaction, and audit metadata.
 *
 * Query parameters:
 *   redaction  — 'full' | 'partial' | 'minimal'  (default: 'partial')
 *   purpose    — string business justification (optional)
 *
 * Headers:
 *   x-wallet-address  — Target subject wallet address (required)
 *   x-requester-role  — 'learner' | 'creator' | 'support_agent' | 'external_auditor' | 'admin'
 *   x-requester-id    — Identity of calling principal (optional)
 *   x-export-purpose  — Audit justification (optional)
 *
 * Error codes: EVT_AUTH_001, EVT_AUTH_FIELD_001, EVT_AUTH_FIELD_002, EVT_ENTITLEMENT_004
 */

import { NextResponse } from 'next/server';
import { getDb }        from '../../../lib/mongodb.js';
import { buildLearnerExport } from '../../../lib/learner-export/buildLearnerExport.js';
import { RedactionLevel, validateExport } from '../../../lib/learner-export/schema.js';
import {
  applyFieldLevelAuthorization,
  ExportRole,
  FieldAuthorizationError,
} from '../../../lib/learner-export/fieldAuthorization.js';

export async function GET(request) {
  // ── authentication & headers ──────────────────────────────────────────────
  const walletAddress = request.headers.get('x-wallet-address') ?? null;
  const rawRequesterRole = request.headers.get('x-requester-role') ?? ExportRole.SUBJECT;
  const requesterId = request.headers.get('x-requester-id') ?? null;
  const { searchParams } = new URL(request.url);
  const purpose = request.headers.get('x-export-purpose') ?? searchParams.get('purpose') ?? 'library_export';

  if (!walletAddress) {
    return NextResponse.json(
      {
        error: {
          code:          'EVT_AUTH_001',
          message:       'Authentication required. Provide a valid session or x-wallet-address.',
          retryable:     false,
          supportAction: null,
        },
      },
      { status: 401 },
    );
  }

  // ── query params ─────────────────────────────────────────────────────────
  const rawRedaction   = searchParams.get('redaction') ?? RedactionLevel.PARTIAL;
  const redactionLevel = Object.values(RedactionLevel).includes(rawRedaction)
    ? rawRedaction
    : RedactionLevel.PARTIAL;

  try {
    const db = await getDb();

    // ── fetch user ──────────────────────────────────────────────────────────
    const user = await db.collection('users').findOne(
      { walletAddressLower: walletAddress.toLowerCase() },
      { projection: { password: 0, webhookSigningSecret: 0, webhookSigningSecretPrevious: 0 } },
    );

    // ── fetch purchases ─────────────────────────────────────────────────────
    const purchases = await db.collection('purchases')
      .find({ buyerAddress: { $regex: new RegExp(`^${escapeRegex(walletAddress)}$`, 'i') } })
      .sort({ createdAt: -1 })
      .toArray();

    const materialIds = [...new Set(
      purchases.map(p => p.materialId).filter(Boolean),
    )];

    // ── fetch supporting collections in parallel ───────────────────────────
    const [entitlements, refunds, materials, progressRecords] = await Promise.all([
      db.collection('entitlement_cache').find({
        buyerAddress: { $regex: new RegExp(`^${escapeRegex(walletAddress)}$`, 'i') },
      }).toArray(),

      db.collection('refunds').find({
        buyerAddress: { $regex: new RegExp(`^${escapeRegex(walletAddress)}$`, 'i') },
      }).toArray(),

      materialIds.length > 0
        ? db.collection('materials').find({ materialId: { $in: materialIds } }).toArray()
        : Promise.resolve([]),

      db.collection('learner_progress').find({
        walletAddress: { $regex: new RegExp(`^${escapeRegex(walletAddress)}$`, 'i') },
      }).toArray(),
    ]);

    // ── assemble base export ───────────────────────────────────────────────
    const baseExport = buildLearnerExport({
      user: user || { walletAddress },
      purchases,
      entitlements,
      refunds,
      materials,
      progressRecords,
      redactionLevel,
    });

    // ── validate schema ────────────────────────────────────────────────────
    const violations = validateExport(baseExport);
    if (violations.length > 0) {
      console.error('[learner-export] schema violations:', violations);
      return NextResponse.json(
        {
          error: {
            code:          'EVT_ENTITLEMENT_004',
            message:       'Export assembly error. Please try again.',
            retryable:     true,
            supportAction: 'retry_later',
          },
        },
        { status: 500 },
      );
    }

    // ── apply field-level authorization ────────────────────────────────────
    const privacySafeExport = applyFieldLevelAuthorization(baseExport, {
      requesterRole: rawRequesterRole,
      requesterId,
      subjectWallet: walletAddress,
      purpose,
    });

    return NextResponse.json(privacySafeExport, {
      status: 200,
      headers: {
        'Content-Disposition': `attachment; filename="eduvault-export-${Date.now()}.json"`,
        'Cache-Control': 'no-store',
        'x-export-role': rawRequesterRole,
      },
    });

  } catch (err) {
    if (err instanceof FieldAuthorizationError) {
      return NextResponse.json(
        {
          error: {
            code: err.code,
            message: err.message,
            retryable: false,
            supportAction: null,
          },
        },
        { status: err.status || 403 },
      );
    }

    console.error('[learner-export] unexpected error:', err);
    return NextResponse.json(
      {
        error: {
          code:          'EVT_ENTITLEMENT_004',
          message:       'Library export temporarily unavailable.',
          retryable:     true,
          supportAction: 'retry_later',
        },
      },
      { status: 500 },
    );
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
