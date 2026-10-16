/**
 * GET /api/learner-export
 *
 * Export the authenticated learner's complete library: purchased materials,
 * immutable receipt anchors, progress/bookmarks, and refund state.
 *
 * Authorization (#790)
 * ────────────────────
 * The export exposes purchase history and PII, so it is scoped strictly to
 * the authenticated session user. The caller can never request another
 * user's export: every query is filtered by the wallet address resolved from
 * the session, not from a client-supplied header or parameter.
 *
 * Feature flag (#797)
 * ────────────────────
 * Gated behind FEATURE_FLAG_LEARNER_DATA_EXPORT. When the flag is off (the
 * safe default) the endpoint returns 503 — missing configuration falls back
 * to the safer behavior of not exposing data.
 *
 * Retention (#790)
 * ────────────────
 * Exports are generated on demand and never stored server-side, so there is
 * no artifact to expire. The response carries a `retention` block and
 * `Cache-Control: no-store` so intermediaries don't cache it.
 *
 * Query parameters:
 *   redaction  — 'full' | 'partial' | 'minimal'  (default: 'partial')
 *
 * Response:
 *   200 application/json — LearnerExport document (see src/lib/learner-export/schema.js)
 *   401 — not authenticated
 *   403 — account suspended
 *   503 — feature flag disabled
 *   500 — internal error
 *
 * Error codes: EVT_AUTH_001, EVT_AUTH_002, EVT_ENTITLEMENT_004
 * (see docs/API_REFERENCE.md)
 */

import { NextResponse } from 'next/server';
import { getDb }        from '../../../lib/mongodb.js';
import { buildLearnerExport } from '../../../lib/learner-export/buildLearnerExport.js';
import { RedactionLevel, validateExport } from '../../../lib/learner-export/schema.js';
import { requireActiveUser } from '../../../lib/api/auth.js';
import { withApiHardening } from '../../../lib/api/hardening.js';
import { isFeatureFlagEnabled } from '../../../lib/featureFlags.js';

// Cap on purchase records per export. A learner can realistically hold a few
// hundred materials; anything beyond this is almost certainly an error or an
// attempt to bulk-harvest the collection, so we bound the work instead of
// letting an unbounded query run.
const MAX_PURCHASES_PER_EXPORT = Number(process.env.EXPORT_MAX_PURCHASES || 1000);

export async function GET(request) {
  return withApiHardening(
    request,
    { route: 'learner-export', rateLimit: { limit: 10, windowMs: 60_000 } },
    async () => {
      // ── feature flag: missing config falls back to the safer behavior ──────
      if (!isFeatureFlagEnabled('LEARNER_DATA_EXPORT')) {
        return NextResponse.json(
          {
            error: {
              code: 'EVT_ENTITLEMENT_004',
              message: 'Data export is not enabled on this deployment.',
              retryable: false,
              supportAction: null,
            },
          },
          { status: 503 },
        );
      }

      // ── authentication: resolve the session user, never a client header ───
      const auth = await requireActiveUser(request);
      if (!auth.ok) {
        return NextResponse.json(
          {
            error: {
              code: auth.status === 403 ? 'EVT_AUTH_002' : 'EVT_AUTH_001',
              message: 'Authentication required. Provide a valid session token.',
              retryable: false,
              supportAction: null,
            },
          },
          { status: auth.status },
        );
      }
      const user = auth.user;

      // ── query params ─────────────────────────────────────────────────────
      const { searchParams } = new URL(request.url);
      const rawRedaction     = searchParams.get('redaction') ?? RedactionLevel.PARTIAL;
      const redactionLevel   = Object.values(RedactionLevel).includes(rawRedaction)
        ? rawRedaction
        : RedactionLevel.PARTIAL;

      try {
        const db = await getDb();

        // ── fetch purchases, scoped to the authenticated user ──────────────
        const purchases = await db.collection('purchases')
          .find({ buyerAddress: user.walletAddressLower ?? user.walletAddress })
          .sort({ createdAt: -1 })
          .limit(MAX_PURCHASES_PER_EXPORT)
          .toArray();

        const materialIds = [...new Set(
          purchases.map(p => p.materialId).filter(Boolean),
        )];

        // ── fetch supporting collections, all scoped to the same user ──────
        const [entitlements, refunds, materials, progressRecords] = await Promise.all([
          db.collection('entitlement_cache').find({
            buyerAddress: user.walletAddressLower ?? user.walletAddress,
          }).toArray(),

          db.collection('refunds').find({
            buyerAddress: user.walletAddressLower ?? user.walletAddress,
          }).toArray(),

          materialIds.length > 0
            ? db.collection('materials').find({ materialId: { $in: materialIds } }).toArray()
            : Promise.resolve([]),

          db.collection('learner_progress').find({
            walletAddress: user.walletAddressLower ?? user.walletAddress,
          }).toArray(),
        ]);

        // ── assemble export ─────────────────────────────────────────────────
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
    },
  );
}
