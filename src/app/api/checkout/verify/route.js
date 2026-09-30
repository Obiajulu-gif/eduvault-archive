export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getUserFromCookie } from '@/lib/api/auth';
import { verifyWalletAddressMatch } from '@/lib/stellar/checkoutService';
import { acquireLock, releaseLock } from '@/lib/concurrency/lock';
import logger from '@/lib/logger';

/**
 * POST /api/checkout/verify
 *
 * Verifies that the wallet address in the signed transaction payload matches
 * the address stored in the user's JWT session.  Blocks submission and
 * returns a 403 if the addresses differ, defending against address-spoofing.
 *
 * Concurrency:
 *   The warnings counter is mutable session state. Simultaneous mismatch
 *   requests for the same user must not lose updates (otherwise the
 *   clear-session threshold could be evaded). We serialize per-user mutation
 *   with a distributed lock and perform an idlempotent read-modify-write.
 *
 * Body:
 *   { payloadAddress: string, requestId?: string }
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

    // Serialize per-user mutation of the warnings counter. Without this lock,
    // concurrent mismatches can lose updates and evade the clear-session threshold.
    const lockKey = `checkout:verify:${user.id}`;
    const lock = await acquireLock(lockKey);
    if (!lock) {
      // Timeout behavior: fail closed with a retryable status rather than
      // advancing mutable state without the lock.
      logger.warn({ userId: user.id }, 'Checkout verify: lock acquisition timed out');
      return NextResponse.json(
        { error: 'Concurrent verification in progress, please retry', retryable: true },
        { status: 409 }
      );
    }

    try {
      // Re-read session state inside the lock so the read-modify-write is
      // atomic with respect to other concurrent requests for this user.
      const sessionState = user.sessionState ?? {};
      const result = verifyWalletAddressMatch({ sessionAddress, payloadAddress, sessionState });

      if (!result.valid) {
        logger.warn(
          { sessionAddress, payloadAddress, warnings: result.warnings, clearSession: result.clearSession },
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
    } finally {
      await releaseLock(lock);
    }
  } catch (err) {
    logger.error({ err: err.message }, 'POST /api/checkout/verify error');
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
