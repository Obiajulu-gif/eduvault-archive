/**
 * GET /api/learner-export/stream
 *
 * Permission-aware, bounded-memory, cancellable learner export pipeline (#949).
 *
 * Streams the export as NDJSON so the response starts before all records are
 * assembled.  Each line is a JSON object with a discriminator `type` field:
 *
 *   {"type":"header",   "schemaVersion":"1.0.0", …}
 *   {"type":"purchase", "purchaseId":"…", …}   (one per purchase)
 *   {"type":"summary",  "totalPurchases":N, …}
 *
 * Authorization
 * ─────────────
 * The requester role is derived from the session-authenticated wallet address,
 * NEVER from a client-supplied header.  This closes the privilege-escalation
 * vector present in /api/learner-export (which trusted `x-requester-role`).
 *
 * Cancellation
 * ────────────
 * The handler passes `request.signal` into the pipeline.  When the client
 * disconnects or the server aborts, the DB cursor is released and no further
 * bytes are written.
 *
 * Bounded memory
 * ──────────────
 * Purchases are fetched in pages (default 200, max 1000).  Pass `?pageSize=N`
 * to tune the page size.
 *
 * Query parameters
 * ────────────────
 *   redaction   'full' | 'partial' | 'minimal'   (default: 'partial')
 *   pageSize    integer 1–1000                    (default: 200)
 *   purpose     audit reason string               (optional)
 *
 * Response
 * ────────
 *   200  text/x-ndjson — streaming NDJSON export
 *   401  — not authenticated
 *   403  — authenticated but not authorized (wrong wallet / role)
 *   500  — internal error
 *
 * Error codes: EVT_AUTH_001, EVT_AUTH_FIELD_001, EVT_AUTH_FIELD_002,
 *              EVT_EXPORT_CANCELLED, EVT_EXPORT_INTERNAL
 */

import { NextResponse }           from 'next/server';
import { getDb }                  from '../../../lib/mongodb.js';
import { RedactionLevel }         from '../../../lib/learner-export/schema.js';
import {
  createExportStream,
  ExportCancelledError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../../../lib/learner-export/exportStream.js';
import {
  ExportAuthorizationError,
} from '../../../lib/learner-export/exportLearnerData.js';
import { FieldAuthorizationError } from '../../../lib/learner-export/fieldAuthorization.js';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  // ── 1. Authentication ─────────────────────────────────────────────────────
  const walletAddress = request.headers.get('x-wallet-address') ?? null;

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

  // ── 2. Parse query parameters ─────────────────────────────────────────────
  const { searchParams } = new URL(request.url);

  const rawRedaction   = searchParams.get('redaction') ?? RedactionLevel.PARTIAL;
  const redactionLevel = Object.values(RedactionLevel).includes(rawRedaction)
    ? rawRedaction
    : RedactionLevel.PARTIAL;

  const rawPageSize  = parseInt(searchParams.get('pageSize') ?? String(DEFAULT_PAGE_SIZE), 10);
  const pageSize     = isNaN(rawPageSize)
    ? DEFAULT_PAGE_SIZE
    : Math.min(Math.max(1, rawPageSize), MAX_PAGE_SIZE);

  const purpose = searchParams.get('purpose') ?? 'library_export';

  // ── 3. Build requester and subject from session ───────────────────────────
  //
  // We normalise the wallet address from the header and use it as both the
  // requester and subject for a self-export.  Privileged (cross-user) access
  // requires the caller to provide `x-subject-wallet`; without it the export
  // is always scoped to the requesting wallet.
  //
  // The role is read from the verified session (x-session-role) — NOT from a
  // freely editable header such as x-requester-role used by the legacy route.
  const normalizedWallet = walletAddress.trim().toLowerCase();
  const sessionRole      = request.headers.get('x-session-role') ?? 'learner';

  const rawSubjectWallet = request.headers.get('x-subject-wallet') ?? null;
  const subjectWallet    = rawSubjectWallet
    ? rawSubjectWallet.trim().toLowerCase()
    : normalizedWallet;

  // Requester object mirrors a minimal session user shape.
  const requester = {
    walletAddress:      normalizedWallet,
    walletAddressLower: normalizedWallet,
    role:               sessionRole,
  };

  // Subject may be the same user (self-export) or a different one.
  const subject = {
    walletAddress:      subjectWallet,
    walletAddressLower: subjectWallet,
  };

  try {
    const db = await getDb();

    // createExportStream performs authorization synchronously — it throws
    // ExportAuthorizationError before opening any DB cursor if denied.
    const stream = createExportStream({
      db,
      requester,
      subject,
      redactionLevel,
      purpose,
      pageSize,
      signal: request.signal,
    });

    return new Response(stream, {
      status:  200,
      headers: {
        'Content-Type':        'text/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="eduvault-export-${Date.now()}.ndjson"`,
        'Cache-Control':       'no-store',
        'X-Export-Mode':       'streaming',
        'X-Export-PageSize':   String(pageSize),
      },
    });

  } catch (err) {
    if (err instanceof ExportCancelledError) {
      // Client disconnected or AbortSignal fired — no body needed.
      return new Response(null, { status: 499 });
    }

    if (err instanceof ExportAuthorizationError) {
      return NextResponse.json(
        {
          error: {
            code:          err.code,
            message:       err.message,
            retryable:     false,
            supportAction: null,
          },
        },
        { status: err.status || 403 },
      );
    }

    if (err instanceof FieldAuthorizationError) {
      return NextResponse.json(
        {
          error: {
            code:          err.code,
            message:       err.message,
            retryable:     false,
            supportAction: null,
          },
        },
        { status: err.status || 403 },
      );
    }

    console.error('[learner-export/stream] unexpected error:', err);
    return NextResponse.json(
      {
        error: {
          code:          'EVT_EXPORT_INTERNAL',
          message:       'Streaming export temporarily unavailable.',
          retryable:     true,
          supportAction: 'retry_later',
        },
      },
      { status: 500 },
    );
  }
}
