# Implementation summary - issue #1190

## Overview

Added frontend recovery UX for interrupted Stellar wallet signing in the cart checkout. The work is a focused vertical slice: a versioned sessionStorage record, a stage-aware decision model, a single recovery banner, resume/retry/verify actions, and automated tests plus documentation of edge cases and rollback behavior.

## Location

- `src/lib/transactions/checkoutRecovery.js`
- `src/hooks/useCheckoutRecovery.js`
- `src/hooks/useStellarTransaction.js`
- `src/providers/CartProvider.jsx`
- `src/components/transactions/CheckoutRecoveryBanner.jsx`
- `src/components/transactions/CheckoutRecoveryNotice.jsx`
- `src/app/layout.js`
- `docs/checkout-signing-recovery.md`

## Features

- **Normal path:** checkout writes a recovery record before requesting a signature and clears it only after the server confirms all purchases.
- **Failure path:** cancellation, rejection, network failure, expiry, corruption, and clock skew each produce an explicit, non-destructive decision.
- **Retry path:** a captured signed XDR is resubmitted without asking for a second wallet approval.
- **Authorization path:** records are bound to the originating wallet; a different connected wallet sees Reconnect only, and submitted transactions require a chain lookup before any new signature.
- **Accessibility:** resumable decisions use `role="status"`; verification and attention states use `role="alert"` with labelled title and description.

## Tests

- `src/lib/transactions/checkoutRecovery.test.js`
- `src/hooks/__tests__/useCheckoutRecovery.test.jsx`
- `src/components/__tests__/CheckoutRecoveryBanner.test.jsx`

## Documentation

- `docs/checkout-signing-recovery.md` covers the decision table, storage contract, edge cases, recovery and rollback behavior, and migration notes.
- `README.md` links the new document.

## Contract preservation

No API or contract changes. `execute()` remains compatible and only adds a `signedXdr` field to its return value. No migration is required; the new sessionStorage key is versioned and leftovers expire within 30 minutes.
