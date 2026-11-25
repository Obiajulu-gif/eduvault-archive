# Checkout signing recovery (issue #1190)

## What this covers

The cart checkout is the only active frontend path that asks a Stellar wallet to sign a real purchase transaction. Before this change, `useStellarTransaction` kept that state only in React memory, so closing the tab or rejecting the wallet request left no frontend record of what had happened. The user had to guess whether to pay again.

This slice adds a versioned, tab-scoped recovery record and one visible banner that turns the last recorded signing stage into a single safe action. It does not change the Soroban contract, `/api/purchase`, quote handling, or entitlement rules.

## Files

| File | Role |
| --- | --- |
| `src/lib/transactions/checkoutRecovery.js` | Pure record format, TTL, stage transitions, and action classification. |
| `src/hooks/useCheckoutRecovery.js` | React binding that reads/writes the record and exposes the current decision. |
| `src/hooks/useStellarTransaction.js` | Emits stage callbacks, returns the signed XDR, and adds resubmit/verify helpers. |
| `src/providers/CartProvider.jsx` | Persists stages, resumes the remaining cart, and clears the record only after server confirmation. |
| `src/components/transactions/CheckoutRecoveryBanner.jsx` | The single visible recovery surface. |
| `src/components/transactions/CheckoutRecoveryNotice.jsx` | Root-layout container wiring the banner to cart and wallet actions. |

## Decision table

The record's `intent.stage` is the source of truth. The banner never signs, submits, or clears a record by itself; all actions go through `CartProvider.resumeCheckout()`.

| Last stage | Banner action | New wallet signature? | Verification first? | Why |
| --- | --- | --- | --- | --- |
| No record / no intent | Resume checkout | Yes | No | The attempt never reached signing. |
| `awaiting_signature` | Resume checkout | Yes | No | The wallet request was cancelled or the tab closed before approval. Nothing was broadcast. |
| `signed` | Retry submission | No | No, but the saved XDR is resubmitted | A signed transaction already exists. Asking for a second signature risks a duplicate payment. |
| `submitted` | Check payment | No | Yes, one `getTransaction` RPC lookup | The transaction may already be on-chain. Do not create a new quote or signature until its status is known. |
| `confirmed` | Check payment | No | Yes | Chain confirmation happened, but the server purchase call may not have completed. |
| Wallet mismatch | Reconnect wallet | No | No | The record is bound to the wallet address that started it. Resume stays disabled until that wallet reconnects. |
| Corrupt, expired, or future-dated record | Dismiss only | No | No | The record is cleared and cannot be replayed. |

`Resume` and `Retry` use `role="status"`; `Verify`, wallet mismatch, and other attention states use `role="alert"` so they are announced immediately.

## Storage contract

- Key: `eduvault.checkout.recovery.v1` in `window.sessionStorage`.
- Scope: one active attempt per tab. Closing the browser tab discards it; reloading the same tab keeps it.
- TTL: 30 minutes from `createdAt`. Stage updates change `updatedAt` but never extend `createdAt`.
- Contents: cart item id/title/price/asset, wallet address, delivery email, stage, material id, quote id, amount, asset, optional transaction hash, optional signed XDR, and ids of items already confirmed.
- No private keys or wallet secrets are stored. The signed XDR is a broadcastable transaction and is cleared as soon as the purchase is confirmed or the user dismisses the banner.

Invalid, expired, and clock-skewed records are deleted on read. A wallet-mismatched record is kept so reconnecting the original wallet still works; the banner explains the mismatch and offers only Reconnect or Dismiss.

## Edge cases and rollback behavior

- **Wallet rejection or close:** `execute()` leaves the stage at `awaiting_signature`. Resume rebuilds the remaining cart from the record and starts a fresh quote and signature.
- **Signature saved, network failure:** the stage is `signed` with the XDR. Retry calls `submitSignedTransaction()` and reuses the original quote, so no second wallet prompt is required.
- **Submitted but confirmation timed out:** the stage is `submitted` with the hash. The banner requires a chain lookup. If the network still reports `NOT_FOUND` or `FAILED`, the record remains and no new payment is created.
- **Chain confirmed, server call failed:** the stage advances to `confirmed`. Resume verifies the hash, then replays the same `/api/purchase` request. The existing buyer/material idempotency path returns the already-purchased record instead of charging twice.
- **Multi-item cart:** each item is tracked in order. `completedItemIds` prevents already-confirmed items from being purchased again; resume continues with the first remaining item.
- **Quote expired:** server rejection leaves the record intact and surfaces an actionable error. The user can dismiss and start a fresh checkout; the frontend never silently creates a second signed payment from an expired quote.
- **Storage disabled or blocked:** every persistence call is best-effort. Checkout proceeds normally without recovery.
- **Rollback:** there is no chain rollback. Dismissing only removes the local record. A signed-but-unsubmitted XDR becomes unusable once the record is cleared. Submitted or confirmed transactions are never cancelled from the frontend; use the existing refund/dispute routes if a purchase must be reversed.

## Contract preservation and migration

- No API request or response shape changed. `execute()` still returns `{ hash }` and now also returns `signedXdr`; existing destructuring continues to work.
- `checkout()` still accepts the same email argument and still swallows checkout errors. Its optional second argument is additive and used only by resume.
- No database or contract migration is required. This is a new, versioned sessionStorage key; the reader ignores unknown versions and old keys are never read.
- Rollback is a normal deploy of the previous bundle. Any leftover v1 records expire within 30 minutes and are ignored by the previous code. To roll back faster, clear the `eduvault.checkout.recovery.v1` key.

## Verification

Automated coverage lives in:

- `src/lib/transactions/checkoutRecovery.test.js` (normal, retry, verify, authorization, expiry, clock skew)
- `src/hooks/__tests__/useCheckoutRecovery.test.jsx` (begin, stage transition, wallet change, dismiss, blocked storage)
- `src/components/__tests__/CheckoutRecoveryBanner.test.jsx` (announced role, action labels, reconnect, dismiss-only, idle)

Run with `npm run test:frontend`.

Manual walkthroughs:

1. Add a material to the cart, enter an email, start checkout, close the wallet request, then reload the tab. The banner should offer Resume checkout.
2. Reject the signature, reload, and confirm the same Resume action appears.
3. Force a network failure after signing and reload. The banner should offer Retry submission and resume without a wallet prompt.
4. Submit successfully but block the `/api/purchase` call, then reload. The banner should offer Check payment and must not create a new signature before the lookup.
5. Connect wallet A, interrupt checkout, then switch to wallet B. The banner should offer Reconnect wallet only.
6. Dismiss the banner and confirm sessionStorage no longer contains the recovery key.
