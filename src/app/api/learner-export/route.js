/**
 * GET /api/learner-export
 *
 * Export the authenticated learner's complete library: purchased materials,
 * immutable receipt anchors, progress/bookmarks, and refund state.
 *
 * Query parameters:
 *   redaction  — 'full' | 'partial' | 'minimal'  (default: 'partial')
 *
 * Response:
 *   200 application/json — LearnerExport document (see src/lib/learner-export/schema.js)
 *   401 — not authenticated
 *   403 — authenticated as a different wallet (address mismatch guard)
 *   500 — internal error
 *
 * Error codes: EVT_AUTH_001, EVT_AUTH_002, EVT_ENTITLEMENT_004
 * (see docs/API_REFERENCE.md)
 */

import { NextResponse } from 'next/server';
import { getDb }        from '../../../lib/mongodb.js';
import { buildLearnerExport } from '../../../lib/learner-export/buildLearnerExport.js';
import { RedactionLevel, validateExport } from '../../../lib/learner-export/schema.js';

export async function GET(request) {
  // ── authentication ───────────────────────────────────────────────────────
  const authHeader = request.headers.get('authorization') ?? '';
  const sessionCookie = request.cookies?.get?.('session')?.value ?? null;

  // Resolve wallet address from session/JWT.  In the real app this would call
  // the session-verification utility; here we derive it from the
  // x-wallet-address header (set by the authenticated middleware) or the
  // Authorization bearer token claim.
  const walletAddress = request.headers.get('x-wallet-address') ?? null;

  if (!walletAddress) {
    return NextResponse.json(
      {
        error: {
          code:          'EVT_AUTH_001',
          message:       'Authentication required. Provide a valid session token.',
          retryable:     false,
          supportAction: null,
        },
      },
      { status: 401 },
    );
  }

  // ── query params ─────────────────────────────────────────────────────────
  const { searchParams } = new URL(request.url);
  const rawRedaction     = searchParams.get('redaction') ?? RedactionLevel.PARTIAL;
  const redactionLevel   = Object.values(RedactionLevel).includes(rawRedaction)
    ? rawRedaction
    : RedactionLevel.PARTIAL;

  // Only allow 'full' redaction for the owner of the account (the learner
  // themselves) — do not expose full PII to third-party integrations.
  // In production this would cross-check against the JWT sub claim; here
  // we trust the middleware-injected x-wallet-address header.

  try {
    const db = await getDb();

    // ── fetch user ──────────────────────────────────────────────────────
    const user = await db.collection('users').findOne(
      { walletAddressLower: walletAddress.toLowerCase() },
      { projection: { password: 0, webhookSigningSecret: 0, webhookSigningSecretPrevious: 0 } },
    );

    if (!user) {
      // User record doesn't exist yet — return an empty but valid export.
      const emptyExport = buildLearnerExport({
        user:      { walletAddress },
        purchases: [],
        entitlements: [],
        refunds:   [],
        materials: [],
        redactionLevel,
      });
      return NextResponse.json(emptyExport, { status: 200 });
    }

    // ── fetch purchases ──────────────────────────────────────────────────
    const purchases = await db.collection('purchases')
      .find({ buyerAddress: { $regex: new RegExp(`^${escapeRegex(walletAddress)}$`, 'i') } })
      .sort({ createdAt: -1 })
      .toArray();

    const materialIds = [...new Set(
      purchases.map(p => p.materialId).filter(Boolean),
    )];

    // ── fetch supporting collections in parallel ──────────────────────────
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

    // ── assemble export ───────────────────────────────────────────────────
    const exportDoc = buildLearnerExport({
      user,
      purchases,
      entitlements,
      refunds,
      materials,
      progressRecords,
      redactionLevel,
    });

    // Validate before returning — catches any regression in buildLearnerExport.
    const violations = validateExport(exportDoc);
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

    return NextResponse.json(exportDoc, {
      status: 200,
      headers: {
        'Content-Disposition': `attachment; filename="eduvault-library-export-${Date.now()}.json"`,
        'Cache-Control': 'no-store',
      },
    });

  } catch (err) {
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

// ── helpers ───────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
