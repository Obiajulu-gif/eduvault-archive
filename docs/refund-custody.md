# Refund Signer Custody (Issue #27)

This document covers the operational controls around the key that signs
refund payments. The signing code lives in `src/lib/stellar/refundSigner.js`
and is the *only* place `STELLAR_ADMIN_SECRET` is read for refunds.

## What this is (and isn't)

Refunds are signed by a single hot-wallet keypair (`STELLAR_ADMIN_SECRET`),
loaded once per process and used only inside `refundSigner.js`. This is not a
KMS/HSM/multisig integration — no such infrastructure exists in this
codebase today. The controls below are the least-privilege, rotation, and
emergency-disable procedures available for this signer model. Moving to a
hardware-backed or multisig signer is a larger infrastructure change tracked
separately; adopting one only requires replacing the internals of
`refundSigner.js` — every caller goes through `signRefundTransaction()`.

## Least privilege

- The refund signer's secret must **never** be read outside
  `src/lib/stellar/refundSigner.js`. If you need the signer's public key or
  to sign a refund transaction, import from that module — do not call
  `Keypair.fromSecret(process.env.STELLAR_ADMIN_SECRET)` anywhere else.
- Keep the refund signer account funded only with what's needed to cover
  expected refund volume over a short window (days, not months). Treat it as
  an operational float, not a treasury — sweep excess balance to cold
  storage on a schedule.
- Set `REFUND_MAX_AMOUNT_PER_TX` to the largest single refund your policy
  ever allows. This cap is enforced inside the signer itself
  (`assertWithinSignerLimit`), independent of whatever amount the refund
  workflow computed — a bug or compromise in the workflow layer still can't
  move more than this per transaction.

## Emergency disable

Set `REFUND_SIGNING_DISABLED=true` (env var, requires a redeploy/restart to
take effect) to immediately stop all refund signing. `signRefundTransaction`
throws before touching the keypair whenever this is set, so in-flight
refunds stay parked in `approved`/`submitting` → they retry automatically
once the flag is cleared — no data is lost, no partial payment is made.

Use this when:
- The refund signer's secret is suspected compromised.
- A bug in the refund workflow is producing incorrect amounts/destinations
  and needs to be stopped before any more transactions land.

## Rotation

1. Generate a new Stellar keypair.
2. Submit a `set_options` transaction on the *current* signer account adding
   the new key, then a second `set_options` transaction removing the old
   key (or lowering its weight to 0) — this avoids any window where the
   account has no valid signer.
3. Update `STELLAR_ADMIN_SECRET` (and `STELLAR_ADMIN_PUBLIC_KEY`) in the
   deployment's secret store.
4. Set `REFUND_SIGNING_DISABLED=true`, redeploy so every process picks up
   the new secret, then set it back to `false`.
5. Confirm the next refund settles correctly before considering the
   rotation complete; keep the old key's `set_options` removal transaction
   ready to submit early if anything looks wrong.

Rotate on a regular schedule (e.g. quarterly) and immediately on suspected
compromise.

## Refund signer versioning, rotation, and compromise recovery (#666)

Refund authorization payloads carry a **signer version** and an **expiry** bound:

- `PurchaseManager::verify_refund_authorization(signer_version, issued_at, expires_at)` requires the payload version to match the contract's active `RefundSignerVersion` (instance storage, default 1) and the current ledger timestamp to be within `[issued_at, expires_at]`.
- `PurchaseManager::set_refund_signer_version(admin, version)` bumps the active version. **Compromise recovery:** bump the version and every authorization signed with an older version is disabled (`RefundSignerDisabled`) without touching valid historical records.
- Replayed payloads are rejected by the expiry bound (`RefundAuthorizationExpired`); version mismatches are rejected distinctly (`RefundSignerVersionMismatch`).

Rotation procedure: issue new payloads under the new version, bump the contract version, then rotate the signing key per the existing custody guidance below.
