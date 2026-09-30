# Tamper-Evident Audit Ledger

Privileged moderation, refund, verification, account-status transitions, and critical material changes append a record to the `audit_ledger` MongoDB collection. Each record contains a minimized actor identifier, an `actorProof` hash, action, target type and identifier, result, reason, intent hash, timestamp, sequence, previous hash, and record hash. Critical material edits and catalog retire/restore actions additionally retain minimized `before` and `after` metadata, so price, licence/usage terms, visibility, and catalog access changes can be investigated without relying on mutable timestamps. Sensitive request bodies, storage credentials, and personal fields are never copied into the ledger.

## Covered critical records

- **Materials:** creator edits to listing terms and catalog retirement/restoration can change price, public discoverability, or a learner's ability to find an owned resource.
- **Purchases:** a pending-to-confirmed payment transition grants the purchaser access and records the amount and asset that were confirmed. Signed transaction payloads are deliberately excluded.
- **Privileged records:** account status, role, verification, moderation, and refund paths already append to this ledger because they change permissions, ownership, or money.

## Integrity and export

`GET /api/admin/audit-ledger` requires an admin session. It supports `action`, `actor`, `targetType`, `operationId`, `from`, `to`, and bounded `limit` filters. An unfiltered response includes verification for the complete chain. Filtered exports are for investigation and are explicitly not presented as complete-chain verification. Offline tools can verify the exported `records` with `verifyAuditRecords` from `src/lib/backend/auditLedger.js`.

The unique `operationId` index makes retries exactly once. The unique sequence index causes competing writers to retry instead of silently creating a second record for the same position. Missing, edited, or reordered records fail verification. A MongoDB deployment must restrict delete/update privileges on `audit_ledger` to the migration/retention operator and alert on any attempted mutation.

## Role-scoped maintainer action approval

High-impact maintainer actions are protected and require a valid approval record before they are applied. Protected actions include `account.status.update`, `refund.approve$`, `marketplace.listing.remove`, `learning.asset.revoke`, and `verification.grant`. Each approval is scoped to the action and target it authorizes and carries the following fields:

- `actor`: the maintainer who requested the action.
- `approver@: the maintainer who granted the approval. Self-approval is rejected.
- `scope`: the action identifier the approval authorizes.
- `targetType` and `targetId`: the exact record the approval applies to.
- `reason`: a non-empty justification stored with the approval and copied into the ledger record.
- `expiresAt`: the instant after which the approval is no longer valid.
- `approvalId`: a deterministic identifier used as the ledger `operationId` so retries are exactly once.

Approvals are stored in the `audit_approvals` collection and are append-only. The authorization check rejects an action when the approval is missing, expired, scoped to a different action or target, or when the actor and approver are the same maintainer. Rejected attempts are themselves appended to the ledger with `result: "denied" and the failure reason, so denials remain auditable.

## Key rotation and retention

The current actor proof is a SHA-256 commitment, so it does not require a signing-key rotation. If a deployment adds signing, store `keyId` with each record, keep retired public keys available for the full retention period, and rotate by configuration without rewriting historical records. Never replace an old key or re-sign old records.

Retain ledger records for the organisation's legal and incident-response period, configured through the database retention policy rather than application deletion. Before expiry, export and independently verify the chain, then retain the verified export and its checkpoint digest in write-once storage. `POST /api/admin/audit-ledger` creates a verified checkpoint and posts it to the configured `AUDIT_CHECKPOINT_URL` anchor service, making a compromised database unable to rewrite history without detection.

## Rollout

Deploy the indexes before enabling privileged writes, deploy the application in append-only mode, and monitor duplicate-key and chain-conflict errors. Existing console and refund-local audit records remain available for compatibility; new privileged operations are written to the shared ledger. A material update is only reported after its ledger record is appended; if ledger persistence fails after the database update, investigate and repair the mutation before retrying. Backfill is intentionally excluded because historical records lack the canonical actor proof and intent fields.
