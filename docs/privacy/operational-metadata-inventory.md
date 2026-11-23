# Operational Metadata Inventory

Generated from `src/lib/privacy/dataMinimizationReview.js`

## Field Classification Legend

- **REQUIRED**: Must be present for the record to function; never removable.
- **OPTIONAL**: May be absent or null; safe to omit.
- **SENSITIVE**: Contains PII, credentials, or keys; requires explicit justification.
- **REMOVABLE**: Candidate for removal; migration/cleanup guidance provided.

## sensitive_access_log

**Purpose**: Field-name-only access log; see buildSensitiveAccessEvent(). Never stores values.
**Writer**: `src/lib/security/sensitiveAccessLog.js`

### Fields

| Field | Classification | Migration Guidance |
|-------|----------------|-------------------|
| `actorId` | REQUIRED | — |
| `actorType` | REQUIRED | — |
| `at` | REQUIRED | — |
| `correlationId` | REQUIRED | — |
| `decision` | REQUIRED | — |
| `fields` | REQUIRED | — |
| `metadata` | SENSITIVE | Redacted by redactSensitivePayload() at write time. If raw values appear, audit the caller. No migration needed; fix the writer. |
| `purpose` | OPTIONAL | — |
| `resourceId` | REQUIRED | — |
| `resourceType` | REQUIRED | — |

### Migration / Cleanup Guidance

- **metadata**: Redacted by redactSensitivePayload() at write time. If raw values appear, audit the caller. No migration needed; fix the writer.

## download_access_log

**Purpose**: Download capability decisions; see recordDownloadAccess(). Audit-safe: no tokens or URLs.
**Writer**: `src/lib/downloads/accessLog.js`

### Fields

| Field | Classification | Migration Guidance |
|-------|----------------|-------------------|
| `byteRangeEnd` | OPTIONAL | — |
| `byteRangeStart` | OPTIONAL | — |
| `buyerAddress` | SENSITIVE | Pseudonymous identifier. Required for dispute resolution. If removal needed, replace with salted hash and update lookup paths. |
| `capabilityId` | OPTIONAL | — |
| `decisionSource` | OPTIONAL | — |
| `denialReason` | OPTIONAL | — |
| `event` | REQUIRED | — |
| `ipAddress` | SENSITIVE | PII. Retained for 180 days per retention policy. If minimization requires removal, hash at write time (see sensitiveAccessLog pattern) and update dispute-resolution queries. |
| `materialId` | REQUIRED | — |
| `timestamp` | REQUIRED | — |

### Migration / Cleanup Guidance

- **ipAddress**: PII. Retained for 180 days per retention policy. If minimization requires removal, hash at write time (see sensitiveAccessLog pattern) and update dispute-resolution queries.
- **buyerAddress**: Pseudonymous identifier. Required for dispute resolution. If removal needed, replace with salted hash and update lookup paths.

## idempotency_keys

**Purpose**: Request replay guard; see withIdempotency().
**Writer**: `src/lib/backend/idempotency.js`

### Fields

| Field | Classification | Migration Guidance |
|-------|----------------|-------------------|
| `claimId` | REQUIRED | — |
| `completedAt` | OPTIONAL | — |
| `createdAt` | REQUIRED | — |
| `error` | OPTIONAL | May leak internal details. Truncate to 500 chars at write. If removal needed, replace with error code enum. |
| `expiresAt` | REQUIRED | — |
| `failedAt` | OPTIONAL | — |
| `lockExpiresAt` | REQUIRED | — |
| `payloadHash` | SENSITIVE | One-way SHA-256 of canonicalized payload. Not reversible. Retained for collision detection. If removal needed, truncate after claim completion and update withIdempotency() to not store it. |
| `response` | OPTIONAL | May contain business data. Retained for replay. If minimization required, store only a result summary hash and fetch full response from source-of-truth on replay. |
| `status` | REQUIRED | — |

### Migration / Cleanup Guidance

- **payloadHash**: One-way SHA-256 of canonicalized payload. Not reversible. Retained for collision detection. If removal needed, truncate after claim completion and update withIdempotency() to not store it.
- **response**: May contain business data. Retained for replay. If minimization required, store only a result summary hash and fetch full response from source-of-truth on replay.
- **error**: May leak internal details. Truncate to 500 chars at write. If removal needed, replace with error code enum.

## material_analytics_dedupe

**Purpose**: Opaque HMAC dedupe key; see buildAnalyticsEvent()/applyAnalyticsEvent(). Never contains PII.
**Writer**: `src/lib/backend/analyticsEvents.js`

### Fields

| Field | Classification | Migration Guidance |
|-------|----------------|-------------------|
| `expiresAt` | REQUIRED | — |

### Migration / Cleanup Guidance

No migration guidance needed.

## maintainer_approval_intents

**Purpose**: Proposed maintainer actions awaiting signature; see createApprovalIntent(). Expires after 30 min.
**Writer**: `src/lib/approvals/maintainerApprovalFlow.js`

### Fields

| Field | Classification | Migration Guidance |
|-------|----------------|-------------------|
| `actionType` | REQUIRED | — |
| `actor` | SENSITIVE | Stellar public key (pseudonymous). Required for self-approval prevention. If removal needed, hash at write and update verification logic. |
| `createdAt` | REQUIRED | — |
| `expiresAt` | REQUIRED | — |
| `intentHash` | REQUIRED | — |
| `intentId` | REQUIRED | — |
| `payload` | SENSITIVE | Caller-supplied action parameters. Must never contain secrets. If PII detected, add redaction at write time (see sensitiveAccessLog pattern). |
| `reason` | REQUIRED | — |
| `target` | REQUIRED | — |

### Migration / Cleanup Guidance

- **actor**: Stellar public key (pseudonymous). Required for self-approval prevention. If removal needed, hash at write and update verification logic.
- **payload**: Caller-supplied action parameters. Must never contain secrets. If PII detected, add redaction at write time (see sensitiveAccessLog pattern).

## maintainer_approval_receipts

**Purpose**: Signed approval receipts; see createSignedReceipt()/persistApprovalReceipt(). Immutable once written.
**Writer**: `src/lib/approvals/maintainerApprovalFlow.js`

### Fields

| Field | Classification | Migration Guidance |
|-------|----------------|-------------------|
| `approverAddress` | SENSITIVE | Stellar public key (pseudonymous). Required for audit trail. If removal needed, hash at write and update audit ledger correlation. |
| `decision` | REQUIRED | — |
| `intent` | REQUIRED | Embedded intent copy for self-contained verification. Duplicates intent collection. If minimization required, store only intentHash and fetch intent on demand. |
| `intentHash` | REQUIRED | — |
| `intentId` | REQUIRED | — |
| `receiptId` | REQUIRED | — |
| `signature` | SENSITIVE | Ed25519 signature. Required for cryptographic verification. Cannot be removed without breaking the approval model. |
| `signedAt` | REQUIRED | — |

### Migration / Cleanup Guidance

- **approverAddress**: Stellar public key (pseudonymous). Required for audit trail. If removal needed, hash at write and update audit ledger correlation.
- **signature**: Ed25519 signature. Required for cryptographic verification. Cannot be removed without breaking the approval model.
- **intent**: Embedded intent copy for self-contained verification. Duplicates intent collection. If minimization required, store only intentHash and fetch intent on demand.