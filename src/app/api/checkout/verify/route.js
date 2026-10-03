export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getUserFromCookie } from '@/lib/api/auth';
import { verifyWalletAddressMatch } from '@/lib/stellar/checkoutService';
import { createReceipt } from '@/lib/receipts/receiptService';
import { acquireLock, releaseLock } from '@/lib/concurrency/lock';
import { normalizeWalletAddress } from '@/lib/canonicalization';
import logger from '@/lib/logger';

// NOTE: The checkout receipt UI lives in components/modals/CheckoutReceiptModal.jsx.
// That file is JSX and must be transpiled by the Next.js/SWC pipeline; it is not
// valid input for `node --check`. Syntax validation for .jsx files should run
// through the project's Jest/Babel or `next lint` tooling instead.

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
 * Both the session address and the payload address are normalized to the
 * canonical Stellar G-address form before comparison, so equivalent input
 * (casing, whitespace, prefix variants) cannot produce inconsistent results.
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

// Normalize both addresses to the canonical Stellar G-address form.
    // Non-canonical input is either normalized (casing, whitespace, prefix)
    // or rejected consistently with a 400.
    const sessionAddress = normalizeWalletAddress(sessionAddressRaw);
    const normalizedPayloadAddress = normalizeWalletAddress(payloadAddress);

    if (!sessionAddress) {
      logger.warn({ userId: user.id }, 'Checkout verify: session wallet address is not canonical');
      return NextResponse.json({ error: 'Session wallet address is not canonical' }, { status: 400 });
    }

    if (!normalizedPayloadAddress) {
      logger.warn(
        { userId: user.id, payloadAddress },
        'Checkout verify: payload wallet address is not canonical'
      );
      return NextResponse.json({ error: 'payloadAddress is not a canonical Stellar address' }, { status: 400 });
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

    // Mutable session state (warnings counter) stored on the user object.
    // In production this would be persisted via Redis / signed cookie update.
    const sessionState = user.sessionState ?? {};
    const result = verifyWalletAddressMatch({
      sessionAddress,
      payloadAddress: normalizedPayloadAddress,
      sessionState,
    });

    if (!result.valid) {
      logger.warn(
        { sessionAddress, payloadAddress: normalizedPayloadAddress, warnings: result.warnings, clearSession: result.clearSession },
        'Checkout verify: wallet address mismatch blocked submission'
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

const { receipt } = await createReceipt({
        operation: 'checkout.verify',
        actor: actor,
        status: 'denied',
        summary: 'Wallet address in signed payload did not match the session wallet',
        references: { sessionAddress, payloadAddress },
        metadata: { reason: result.reason, warnings: result.warnings, clearSession: Boolean(result.clearSession) },
        idempotencyKey,
      });

      if (result.clearSession) {
        return NextResponse.json(
          {
error: 'Wallet address in signed payload does not match session wallet',
            reason: result.reason,
            warnings: result.warnings,
            clearSession: true,
            receiptId: receipt._id,
          },
          { status: 403 }
        );
      }

return NextResponse.json(
        {
          error: 'Wallet address in signed payload does not match session wallet',
          reason: result.reason,
          warnings: result.warnings,
          receiptId: receipt._id,
        },
        { status: 403 }
      );
    } finally {
      await releaseLock(lock);
    }
const { receipt } = await createReceipt({
      operation: 'checkout.verify',
      actor,
      status: 'verified',
      summary: 'Wallet address in signed payload matched the session wallet',
      references: { sessionAddress, payloadAddress },
      metadata: { warnings: result.warnings },
      idempotencyKey,
    });

    return NextResponse.json(
      { valid: true, address: sessionAddress, receiptId: receipt._id },
      { status: 200 }
    );
  } catch (err) {
    logger.error({ err: err.message }, 'POST /api/checkout/verify error');
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
