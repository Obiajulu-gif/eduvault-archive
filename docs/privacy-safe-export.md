# Privacy-Safe Export with Field-Level Authorization

## Overview
The **Privacy-Safe Export Engine** (`src/lib/learner-export/fieldAuthorization.js`) enforces granular, field-level access control over exported learner data. Depending on the requesting principal (subject learner, creator, support agent, external compliance auditor, or administrator), fields containing Personally Identifiable Information (PII), proprietary platform financials, or private educational notes are selectively permitted, masked, pseudonymized, or redacted.

## Field Authorization Matrix

| Field Path | Subject Learner | Creator | Support Agent | External Auditor | Administrator |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `identity.walletAddress` | **ALLOW** | **MASK** (`GBRP...OX2H`) | **ALLOW** | **HASH / PSEUDONYMIZE** | **ALLOW** |
| `identity.email` | **ALLOW** (FULL redaction) | **REDACT** (null) | **MASK** (`j***e@domain.com`) | **REDACT** (null) | **ALLOW** |
| `identity.fullName` | **ALLOW** (FULL redaction) | **REDACT** (null) | **MASK** (`A***`) | **REDACT** (null) | **ALLOW** |
| `purchases[].sellerNet` | **REDACT** (internal) | **ALLOW** (revenue) | **ALLOW** | **ALLOW** | **ALLOW** |
| `purchases[].platformFee` | **REDACT** (internal) | **ALLOW** | **ALLOW** | **ALLOW** | **ALLOW** |
| `purchases[].progress.bookmarks[].note` | **ALLOW** (private notes) | **REDACT** | **REDACT** | **REDACT** | **ALLOW** |
| `purchases[].progress.progressPct` | **ALLOW** | **ALLOW** | **ALLOW** | **REDACT** | **ALLOW** |
| `purchases[].refund.reason` | **ALLOW** | **ALLOW** | **ALLOW** | **MASK** (compliance code) | **ALLOW** |
| `purchases[].receiptAnchors` | **ALLOW** | **ALLOW** | **ALLOW** | **ALLOW** | **ALLOW** |

## Audit & Verification Metadata
Each exported document is augmented with an immutable `privacyMeta` block:
```json
{
  "privacyMeta": {
    "requesterRole": "external_auditor",
    "requesterId": "auditor-2026",
    "purpose": "annual_financial_audit",
    "fieldsRedacted": ["identity.email", "identity.fullName", "purchases[].progress"],
    "fieldsMasked": ["identity.walletAddress", "purchases[].refund.reason"],
    "authorizedAt": "2026-10-16T17:30:00.000Z",
    "contentChecksum": "3a8f..."
  }
}
```

## Security & Operational Guards

### 1. Cross-Subject Authorization Enforcement
- When a caller requests an export with role `learner` (the subject), the system verifies that `x-wallet-address` matches the authenticated subject session. Cross-tenant or cross-wallet queries fail closed with `403 Forbidden` (`EVT_AUTH_FIELD_002`).

### 2. Unknown or Tampered Role Headers
- If an unrecognized role is provided in `x-requester-role`, the request fails closed with `403 Forbidden` (`EVT_AUTH_FIELD_001`).

### 3. Fail-Closed Resilience & Retries
- In case of database connectivity interruptions during export assembly, the API returns a retryable 500 status with `retryable: true` and `supportAction: 'retry_later'`. Field-level transformations are deterministic pure functions with idempotent output.

## Rollback & Backward Compatibility
- Existing API clients calling `GET /api/learner-export` with `x-wallet-address` and optional `?redaction=full|partial|minimal` without specifying `x-requester-role` seamlessly default to `ExportRole.SUBJECT` (the learner's own library export), preserving existing wire contracts.
