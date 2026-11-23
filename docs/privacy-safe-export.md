# Privacy-Safe Export with Field-Level Authorization (#1017, #1151)

## Overview
The **Privacy-Safe Export Engine** (`src/lib/learner-export/fieldAuthorization.js`) enforces granular, field-level access control over exported learner data. Depending on the requesting principal (subject learner, creator, support agent, external compliance auditor, or administrator), fields containing Personally Identifiable Information (PII), proprietary platform financials, or private educational notes are selectively permitted, masked, pseudonymized, or redacted.

---

## Field Authorization Matrix

| Field Path | Subject Learner | Creator | Support Agent | External Auditor | Administrator |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `identity.walletAddress` | **ALLOW** | **MASK** (`GBEX...2345`) | **ALLOW** | **HASH / PSEUDONYMIZE** (`pseudo_...`) | **ALLOW** |
| `identity.email` | **ALLOW** | **REDACT** (`null`) | **MASK** (`a***e@example.com`) | **REDACT** (`null`) | **ALLOW** |
| `identity.fullName` | **ALLOW** | **REDACT** (`null`) | **MASK** (`A***`) | **REDACT** (`null`) | **ALLOW** |
| `purchases[].sellerNet` | **REDACT** (`null`) | **ALLOW** | **ALLOW** | **ALLOW** | **ALLOW** |
| `purchases[].platformFee` | **REDACT** (`null`) | **ALLOW** | **ALLOW** | **ALLOW** | **ALLOW** |
| `purchases[].progress.bookmarks[].note` | **ALLOW** (private notes) | **REDACT** | **REDACT** | **REDACT** | **ALLOW** |
| `purchases[].progress` | **ALLOW** | **ALLOW** | **ALLOW** | **REDACT** (`null`) | **ALLOW** |
| `purchases[].refund.reason` | **ALLOW** | **ALLOW** | **ALLOW** | **MASK** (`refund_processed_compliance_redacted`) | **ALLOW** |
| `purchases[].receiptAnchors` | **ALLOW** | **ALLOW** | **ALLOW** | **ALLOW** | **ALLOW** |

---

## Architecture & Core Components

### 1. Granular Field Masking & Pseudonymization
- **Email Masking (`maskEmail`)**: Retains first and last characters of local part and complete domain (`ada.lovelace@example.com` $\to$ `a***e@example.com`).
- **Wallet Masking (`maskWalletAddress`)**: Preserves leading 4 and trailing 4 characters (`GBVI...J6L3`).
- **Cryptographic Pseudonymization (`pseudonymize`)**: Non-reversible truncated SHA-256 hash using a salt (`pseudo_a1b2c3d4e5f67890`), allowing auditors to group records without identifying individual user wallets.

### 2. Authorization Enforcement (`assertExportAuthorization`)
- Validates that `requesterRole` belongs to known `ExportRole` constants.
- Cross-subject isolation: Requesters acting as `SUBJECT` can only export data matching their own `subjectWallet`. Mismatches immediately fail with `403 Forbidden` (`EVT_AUTH_FIELD_002`).

### 3. Resilient Pipeline with Retries (`exportWithPrivacyAuthorization`)
- Wraps upstream data fetching with configurable retry counts and exponential backoff ($delay \times 2^{attempt}$).
- Transient storage or network errors are retried automatically.
- Authorization and input validation errors fail fast immediately without redundant retries.

### 4. Cryptographic Tamper-Evidence (`verifyExportIntegrity`)
- Calculates a canonical SHA-256 checksum over the identity and purchases structures.
- Attaches `privacyMeta.contentChecksum` to the export document.
- Provides `verifyExportIntegrity(doc)` to detect any post-export tampering or data manipulation.

```json
{
  "privacyMeta": {
    "requesterRole": "external_auditor",
    "requesterId": "auditor-2026",
    "purpose": "compliance_audit",
    "fieldsRedacted": ["identity.email", "identity.fullName", "purchases[].progress"],
    "fieldsMasked": ["identity.walletAddress", "purchases[].refund.reason"],
    "authorizedAt": "2026-11-20T12:00:00.000Z",
    "contentChecksum": "3a8f9c1b..."
  }
}
```

---

## Complexity Analysis
- **Time Complexity**:
  - `applyFieldLevelAuthorization`: $O(P + B)$ where $P$ is the number of purchases and $B$ is the total count of bookmarks across all purchases. Deep cloning and mapping occur in linear time.
  - `exportWithPrivacyAuthorization`: $O(R \cdot (T_{fetch} + T_{filter}))$ where $R$ is max retry attempts.
  - `verifyExportIntegrity`: $O(P)$ canonical stringification and SHA-256 digest computation.
- **Space Complexity**:
  - $O(S)$ where $S$ is the size of the export document, required for the deep-cloned output structure to prevent mutating source data.

---

## Edge Cases and Rollback Behavior
1. **Empty Document / Zero Purchases**: Returns empty array with proper metadata and valid checksum.
2. **Missing Identity Fields**: Tolerates null/undefined fields without throwing unhandled exceptions.
3. **Rollback / Backward Compatibility**: Existing callers that do not supply `x-requester-role` automatically default to `ExportRole.SUBJECT` with strict subject wallet verification.
