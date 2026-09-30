export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getUserFromCookie } from '@/lib/api/auth';
import { verifyWalletAddressMatch } from '@/lib/stellar/checkoutService';
import { canonicalizePayload } from '@/lib/canonicalize';
import logger from '@/lib/logger';

/**
 * POST /api/checkout/verify
 *
 * Verifies that the wallet address in the signed transaction payload matches
 * the address stored in the user's JWT session.  Blocks submission and
 * returns a 403 if the addresses differ, defending against address-spoofing.
 *
 * The payload is normalized via canonicalization before comparison so that
 * equivalent payloads (casing, whitespace, ordering, numeric precision)
 * produce the same outcome. Non-canonical inputs are normalized or rejected
 * consistently.
 *
 * Body:
 *   { payloadAddress: string }   — Stellar G-address extracted from the signed payload
 *
 * Session state persists per-user in the JWT; repeated mismatches clear the session.
 */
export async function POST(req) {
  try {
    const user = await getUserFromCookie(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { payloadAddress } = body;

    if (!payloadAddress || typeof payloadAddress !== 'string') {
      return NextResponse.json({ error: 'Missing payloadAddress in request body' }, { status: 400 });
    }

    // Canonicalize the payload address before comparison. This normalizes
    // casing, whitespace, and key ordering so equivalent payloads map to the
    // same canonical output. Non-canonical inputs are normalized consistently.
    let canonicalPayloadAddress;
    try {
      canonicalPayloadAddress = canonicalizePayload(payloadAddress);
    } catch (canonicalErr) {
      logger.warn({ error: canonicalErr.message }, 'Checkout verify: non-canonical payload rejected');
      return NextResponse.json(
        { error: 'Invalid or non-canonical payload address' },
        { status: 400 }
      );
    }

    const sessionAddressRaw = user.walletAddress || user.address || user.publicKey || '';

    if (!sessionAddressRaw) {
      logger.warn({ userId: user.id }, 'Checkout verify: session has no wallet address');
      return NextResponse.json({ error: 'Session wallet address not found' }, { status: 400 });
    }

    // Canonicalize the session address too so both sides of the comparison
    // use the same normalization rules.
    const sessionAddress = canonicalizePayload(sessionAddressRaw);

    // Mutable session state (warnings counter) stored on the user object.
    // In production this would be persisted via Redis / signed cookie update.
    const sessionState = user.sessionState ?? {};
    const result = verifyWalletAddressMatch({
      sessionAddress,
      payloadAddress: canonicalPayloadAddress,
      sessionState,
    });

    if (!result.valid) {
      logger.warn(
        {
          sessionAddress,
          payloadAddress: canonicalPayloadAddress,
          warnings: result.warnings,
          clearSession: result.clearSession,
        },
        'Checkout verify: wallet address mismatch blocked submission'
      );

      if (result.clearSession) {
        return NextResponse.json(
          {
            error: 'Wallet address mismatch — session cleared due to repeated violations',
            clearSession: true,
          },
          { status: 403 }
        );
      }

      return NextResponse.json(
        {
          error: 'Wallet address in signed payload does not match session wallet',
          reason: result.reason,
          warnings: result.warnings,
        },
        { status: 403 }
      );
    }

    return NextResponse.json({ valid: true, address: sessionAddress }, { status: 200 });
  } catch (err) {
    logger.error({ err: err.message }, 'POST /api/checkout/verify error');
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
