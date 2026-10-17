# Maintainer Action Approval Flow (Signed Intent Receipts)

Issue #953 replaces "a maintainer's name in a request body" with a
cryptographic receipt before a high-impact or irreversible action (entitlement
revocation, payout cap change, content takedown, archive purge, etc.) is
allowed to execute. Policy commits previously only checked
`commitRequest.secondaryApprover === "some-string"`
(`src/lib/policies/policySimulator.js`) — nothing verified that maintainer
ever reviewed anything. This flow requires the approving maintainer to sign
the exact proposed action with their wallet.

Implementation: `src/lib/approvals/maintainerApprovalFlow.js`.

## Flow

1. **Propose.** The initiating maintainer calls
   `createApprovalIntent({ actionType, actor, target, payload, reason })`.
   The intent's fields are hashed into `intentHash`
   (`POST /api/admin/approvals`, which also persists the intent server-side
   via `persistApprovalIntent` — the signing step never trusts a
   client-echoed intent).
2. **Review and sign.** A *different* maintainer reviews the intent and
   signs `getApprovalSigningMessage(intent)` with their wallet's Stellar
   keypair (the same Ed25519 keypair used for login, see
   `src/lib/auth/challenge.js`). Domain separation
   (`eduvault:maintainer-approval:v1`) keeps this signature from being
   replayable as a login-challenge signature or vice versa.
3. **Submit.** `POST /api/admin/approvals/{intentId}` with
   `{ signatureHex, decision }`. `createSignedReceipt` verifies the
   signature against the approver's public key (their wallet address),
   rejects self-approval, rejects an expired intent (30-minute TTL), and
   only then produces an immutable receipt.
4. **Persist.** `persistApprovalReceipt` writes the receipt to
   `maintainer_approval_receipts` and appends evidence to the tamper-evident
   `audit_ledger` (`action: "maintainer_action_approval"`).
5. **Execute.** The action executor calls
   `assertApprovalReceiptValid({ intent, receipt })` immediately before doing
   anything irreversible. It re-verifies the signature from scratch — a
   stored "verified" flag is never trusted — and checks the receipt's
   `intentHash` matches the intent being executed, so a signature for one
   action can never authorize a different one.

## What the signature actually covers

`intentHash = canonicalHash({ intentId, actionType, actor, target, payload,
reason, createdAt, expiresAt })`. Changing any of those fields after the
intent was proposed produces a different hash, so a signed receipt binds to
the exact action reviewed — not a mutable description of it.

## Self-approval and replay

- `createSignedReceipt` and `assertApprovalReceiptValid` both reject when
  `receipt.approverAddress === intent.actor` (case-insensitive).
- One receipt per intent: `maintainer_approval_receipts` has a unique index
  on `intentId` — a decision, once signed, is final.
- An expired intent (default 30 minutes) cannot be signed or executed, even
  if a valid-looking signature is presented.

## Storage and indexes

- `maintainer_approval_intents` — unique `intentId`, `{ actor, createdAt }`.
- `maintainer_approval_receipts` — unique `intentId` and `receiptId`,
  `{ approverAddress, signedAt }`.

Declared in `REQUIRED_INDEXES` (`src/lib/backend/schemaContracts.js`).

## API

- `POST /api/admin/approvals` — propose an intent; returns the intent and
  the message the approver must sign.
- `GET /api/admin/approvals/{intentId}` — read intent + receipt status.
- `POST /api/admin/approvals/{intentId}` — submit `{ signatureHex, decision }`.

All three require `admin:access` (`requireAdmin`).

## References

- Implementation: `src/lib/approvals/maintainerApprovalFlow.js`
- Routes: `src/app/api/admin/approvals/route.js`,
  `src/app/api/admin/approvals/[intentId]/route.js`
- Related gate (plain-string approver, predates this flow):
  `src/lib/policies/policySimulator.js`
- Audit trail: `src/lib/backend/auditLedger.js`, `docs/audit-ledger.md`
