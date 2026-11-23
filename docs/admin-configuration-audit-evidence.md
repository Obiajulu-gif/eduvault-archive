# Audit Evidence for Administrative Configuration Changes (#1001)

`src/lib/config/adminConfigAudit.js` provides cryptographic, tamper-evident audit evidence for all administrative configuration updates in EduVault.

When administrators adjust marketplace fees, payout thresholds, session timeout boundaries, data retention windows, or feature flags, every mutation is bound to an immutable cryptographic evidence envelope linked into a verifiable hash chain (blockchain-style ledger).

---

## 1. Architecture & Design Principles

1. **Append-Only Immutability**: Historical evidence entries are never overwritten or deleted. Reverting or correcting a previous configuration change is accomplished by appending a forward-linked `CONFIG_ROLLBACK` evidence record referencing the target `evidenceId`.
2. **Cryptographic Hash Chain**: Every record computes a SHA-256 digest of its canonical JSON payload and links directly to the `recordHash` of the preceding sequence (`previousEvidenceHash`), rooted in a genesis hash (`0000...0000`). Any retroactive mutation, sequence skip, or record reordering breaks the chain.
3. **Actor Commitment Proofs**: Every change binds the administrator's identity, role, setting key, and operation ID into a keyed HMAC commitment (`actorProof`), ensuring changes cannot be repudiated or attributed to another actor.
4. **Secret Redaction by Design**: Snapshots of previous (`before`) and new (`after`) configurations are automatically scanned and sanitized. Sensitive credentials (such as Stellar secret seeds `S...`, JWTs, Bearer tokens, or password strings) are replaced with `[REDACTED:secret]` before serialization.
5. **Two-Person Integrity (Dual-Approval Guard)**: High-impact or irreversible configuration changes (e.g. platform fee modifications, payout transaction caps, permanent archive purge retention) require secondary maintainer approval (`approvalEvidence.approver`). Self-approval is strictly forbidden.
6. **Idempotent Replay**: Client-supplied `operationId` (or `x-idempotency-key`) guarantees that retried network requests return the existing evidence receipt and active state without duplicate writes or sequence conflicts.

---

## 2. Setting Registry & Severity Classification

The module provides a declarative registry (`CONFIG_SETTING_REGISTRY`) that defines schema types, range bounds, and severity classifications:

| Setting Key | Category | Type / Allowed Range | Severity | Dual-Approval | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `marketplace.platformFeeBps` | `marketplace` | Integer [0, 10000] | `CRITICAL` | **Yes** | Platform fee basis points (e.g., 250 = 2.5%). |
| `marketplace.creatorShareBps` | `marketplace` | Integer [0, 10000] | `HIGH` | No | Default creator revenue share basis points. |
| `marketplace.maxBatchSize` | `marketplace` | Integer [1, 1000] | `LOW` | No | Bulk batch size limit for marketplace listings. |
| `financial.maxPayoutPerTx` | `financial` | Number [0.01, 1,000,000] | `CRITICAL` | **Yes** | Maximum creator payout per transaction. |
| `financial.payoutHoldPeriodHours` | `financial` | Integer [0, 720] | `MEDIUM` | No | Creator payout dispute hold period. |
| `financial.minimumPayoutThreshold` | `financial` | Number [0, 10000] | `MEDIUM` | No | Minimum balance threshold for payouts. |
| `security.sessionInactivityTimeoutMinutes` | `security` | Integer [5, 1440] | `HIGH` | No | User session inactivity expiration window. |
| `security.tokenRevocationGraceSeconds` | `security` | Integer [0, 3600] | `HIGH` | No | In-flight token family rotation grace period. |
| `security.maxFailedLoginAttempts` | `security` | Integer [1, 20] | `MEDIUM` | No | Consecutive failed login lockout threshold. |
| `feature_flags.stellar_indexer` | `feature_flags` | Boolean | `MEDIUM` | No | Stellar/Soroban live event ingestion worker. |
| `feature_flags.bulk_refunds` | `feature_flags` | Boolean | `HIGH` | No | Bulk refund execution capability flag. |
| `feature_flags.learner_export` | `feature_flags` | Boolean | `LOW` | No | Self-service learner archive exports. |
| `feature_flags.soroban_smart_contracts`| `feature_flags` | Boolean | `HIGH` | No | Soroban smart contract settlement. |
| `maintenance.global` | `maintenance` | Boolean | `HIGH` | No | Global maintenance mode lock. |
| `maintenance.scope` | `maintenance` | String enum | `MEDIUM` | No | Scope: `global`, `marketplace`, `upload`, etc. |
| `maintenance.message` | `maintenance` | String (max 500 chars) | `LOW` | No | Banner message during maintenance. |
| `storage.permanentPurgeRetentionDays` | `storage` | Integer [1, 3650] | `CRITICAL` | **Yes** | Data retention before soft-deleted archives purge. |
| `storage.maxUploadSizeBytes` | `storage` | Integer [1KB, 10GB] | `MEDIUM` | No | Maximum allowable material upload size. |
| `custom.<category>.<name>` | custom | Validated primitive | `MEDIUM` | No | Extensible namespaced custom setting keys. |

---

## 3. Evidence Envelope Specification

Each configuration change generates an immutable evidence envelope:

```json
{
  "schemaVersion": 1,
  "evidenceId": "ev_cfg_1760832000000_a1b2c3d4",
  "operationId": "req_update_fee_2026_q4",
  "sequence": 14,
  "previousEvidenceHash": "c2b489d87198e018d998074900a08e1694e9f7dc2a77ec9b8d23e59048f349a1",
  "settingKey": "marketplace.platformFeeBps",
  "category": "marketplace",
  "changeType": "CONFIG_UPDATE",
  "severity": "CRITICAL",
  "before": 250,
  "after": 300,
  "diff": {
    "from": 250,
    "to": 300
  },
  "actor": {
    "id": "admin_ops_01",
    "role": "admin",
    "walletAddress": "GADMIN..."
  },
  "actorProof": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "reason": "Platform fee adjustment approved by steering committee for Q4",
  "approvalEvidence": {
    "approver": "admin_finance_02",
    "approvedAt": "2026-10-19T00:30:00.000Z",
    "reason": "Signed off following finance review",
    "approvalToken": "appr_tok_84920"
  },
  "targetEvidenceId": null,
  "status": "applied",
  "createdAt": "2026-10-19T00:30:05.120Z",
  "recordHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "signature": "a7b3c9e2..."
}
```

---

## 4. Operational Paths

### 4.1 Normal Path
1. Authenticated administrator (`role === "admin"`) submits a configuration change with a setting key, new value, and mandatory reason (minimum 5 characters).
2. Input is validated against registry bounds and type requirements.
3. If the setting is classified as `CRITICAL`, secondary maintainer approval (`approvalEvidence.approver !== actor.id`) is verified.
4. The current setting is read from the `system_config` collection. If the proposed value equals the current value, it is rejected as `NOOP_MUTATION`.
5. The latest evidence entry is read to determine `sequence = last.sequence + 1` and `previousEvidenceHash = last.recordHash`.
6. Evidence envelope is created with actor commitment proof and canonical HMAC signature.
7. Evidence is persisted to `config_audit_evidence`.
8. Active configuration is updated in `system_config`.

### 4.2 Failure Path
- **Unauthorized Actor**: Callers without the `admin` role are rejected with `403 UNAUTHORIZED_ADMIN`.
- **Invalid Setting / Value**: Out-of-bounds or invalid type values trigger `400 INVALID_CONFIG_VALUE` or `CONFIG_VALUE_OUT_OF_BOUNDS`.
- **Missing Reason**: Omitting a justification reason fails with `400 MISSING_AUDIT_REASON`.
- **Dual-Approval Missing**: Critical settings without a secondary approver fail with `428 DUAL_APPROVAL_REQUIRED`.
- **Self-Approval Violation**: Submitting the requesting admin as secondary approver fails with `422 SELF_APPROVAL_FORBIDDEN`.
- **Write Failure**: If database persistence of the evidence envelope fails, the active configuration is **never updated** (fail-closed guarantee).

### 4.3 Retry Path
- Callers supply an `operationId` (or HTTP `x-idempotency-key`).
- If an existing record with that `operationId` is found, the system immediately returns `{ success: true, idempotentReplay: true, evidence, config }` without appending a duplicate record or incrementing the sequence.
- Concurrent writer races are resolved using optimistic sequence retries (up to 3 attempts).

### 4.4 Authorization & Access Control
- All endpoints (`/api/admin/config`, `/api/admin/config/rollback`, `/api/admin/config/evidence`) require administrative credentials resolved via `requireAdmin(request)`.

---

## 5. Rollback & Disaster Recovery Runbook

### 5.1 Append-Only Rollback
To revert a configuration change:
1. Locate the `evidenceId` of the change to revert.
2. Submit a rollback request via `rollbackConfigChange()` or `POST /api/admin/config/rollback`.
3. The system fetches the target evidence record, retrieves its `before` state, and generates a **new** evidence entry of type `CONFIG_ROLLBACK` referencing `targetEvidenceId: evidenceId`.
4. If the target change was `CRITICAL`, the rollback itself enforces two-person secondary approval.
5. Active configuration is updated to the previous value.
6. Original historical records remain completely untouched.

### 5.2 Chain Verification & Forensic Tamper Detection
To verify the entire configuration history:
```javascript
import { verifyConfigAuditChain } from '@/lib/config/adminConfigAudit';

const allRecords = await db.collection('config_audit_evidence').find({}).sort({ sequence: 1 }).toArray();
const result = verifyConfigAuditChain(allRecords);

if (!result.valid) {
  console.error(`Chain broken at sequence ${result.brokenAtSequence}:`, result.errors);
}
```

The verifier asserts:
- `sequence === index` (detects dropped or skipped records).
- `previousEvidenceHash === records[i - 1].recordHash` (detects spliced or rewritten records).
- `recordHash === sha256(canonicalize(unsigned))` (detects field modifications).
- `signature === hmac(recordHash, key)` (detects unauthorized record forging).
- `actorProof` consistency (detects actor identity spoofing).

### 5.3 Incident Response: Broken Hash Chain
If verification reports a broken sequence or hash mismatch:
1. **Freeze Writes**: Temporarily enable `maintenance.global` to prevent additional configuration mutations.
2. **Isolate Sequence**: Identify `brokenAtSequence` from the verification report.
3. **Audit Log Inspection**: Cross-reference the database change streams or `audit_ledger` to determine who modified or deleted rows directly through MongoDB.
4. **Preserve Database Dump**: Take a point-in-time snapshot of `config_audit_evidence` for forensics.
5. **Re-anchor**: If records were deleted or corrupted by database operator intervention, restore the affected sequence from write-once audit backups and re-verify the full chain.

---

## 6. API Reference

### `GET /api/admin/config`
Retrieves all registered configuration definitions, active stored values, recent audit evidence entries, and live chain verification status.

### `POST /api/admin/config`
Applies an administrative configuration change.
```json
{
  "settingKey": "marketplace.platformFeeBps",
  "value": 300,
  "reason": "Q4 platform fee adjustment approved by governance committee",
  "operationId": "idem-fee-q4-2026",
  "approvalEvidence": {
    "approver": "admin_secondary_id",
    "reason": "Reviewed and signed off"
  }
}
```

### `POST /api/admin/config/rollback`
Rolls back a prior configuration change by `evidenceId`.
```json
{
  "evidenceId": "ev_cfg_1760832000000_a1b2c3d4",
  "reason": "Reverting fee increase following community feedback",
  "approvalEvidence": {
    "approver": "admin_secondary_id",
    "reason": "Approved rollback"
  }
}
```

### `GET /api/admin/config/evidence`
Exports verifiable evidence bundles with optional filters (`settingKey`, `category`, `actorId`, `from`, `to`, `limit`).

---

## 7. Verification & Automated Tests

- **Backend Test Suite (Node.js test runner)**:
  ```bash
  node --test tests/backend/admin-config-audit-evidence.test.mjs
  ```
  *Coverage*: Registry validation, secret redaction, normal path, hash chain integrity, dual-approval, self-approval prevention, idempotent retries, tamper detection, append-only rollback, and bundle export.

- **Vitest Unit & API Tests**:
  ```bash
  npx vitest run src/lib/config/__tests__/adminConfigAudit.test.js
  npx vitest run src/app/api/admin/config/__tests__/route.test.js
  ```
