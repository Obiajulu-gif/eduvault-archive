# Data Retention and Privacy Policy

This document defines EduVault's data retention, privacy boundaries, and learner data export rules (#708).

## Learner Progress & Bookmarks Privacy

1. **Owner-Only Access**: Learner progress records and bookmark notes are private to the learner (`walletAddress`).
2. **Access Control Enforcement**: API endpoints and internal modules enforce that `requestingActor` matches `walletAddress` before returning progress or export payloads.
3. **No Unsolicited Sharing**: Course creators and maintainers can view aggregate completion metrics, but individual learner bookmarks and custom notes are strictly restricted to the learner's own account.

## Data Retention and Versioning

1. **Version Scoping**: Progress and bookmarks are keyed by `(walletAddress, materialId, version)`.
2. **Immutability across Material Updates**: When creators publish new material versions or issue rollbacks:
   - Historical bookmarks attached to previous material versions are retained intact.
   - Updates never overwrite existing learner bookmark history.
3. **Data Export Rules**: Learners can request a full privacy data export (`exportLearnerProgress`) of all version-scoped progress records in standardized JSON format.

## Learner Library Export API

The complete learner library export — purchased materials, immutable receipt
anchors, progress/bookmarks, refund state, and on-chain verification metadata
— is available at:

```
GET /api/learner-export?redaction=full|partial|minimal
```

**Redaction levels:**

| Level               | `walletAddress` | `email` | `fullName` | Use case                                  |
| ------------------- | --------------- | ------- | ---------- | ----------------------------------------- |
| `full`              | ✓               | ✓       | ✓          | Learner's own GDPR Subject Access Request |
| `partial` (default) | ✓               | —       | —          | Support tickets, dispute resolution       |
| `minimal`           | ✓               | —       | —          | Third-party integrations                  |

**Export contents per purchase:**

- `materialId`, `materialTitle`, `purchasedAt`
- `asset`, `amount`, `platformFee`, `sellerNet` (all in minor units)
- `entitlementState` — one of `active`, `revoked`, `released`, `disputed`, `unknown`
- `refundStatus` — one of `none`, `requested`, `completed`, `rejected`
- `refund` — detail block with amounts, timestamps, and reason (null when no refund)
- `receiptAnchors` — `metadataHash`, `rightsHash`, `saleTermsVersion`, `purchaseLedger`, `transactionId`, and `receiptHash` (SHA-256 of the canonical purchase bundle)
- `progress` — `version`, `progressPct`, `bookmarks[]`, `lastAccessedAt` (null when no progress)

**Verification:** `receiptAnchors.receiptHash` is a SHA-256 of the canonical
purchase + snapshot bundle. Learners can verify it independently against the
on-chain `get_purchase_snapshot(purchaseId)` result without a live API call.

**Schema source:** `src/lib/learner-export/schema.js`
**Builder:** `src/lib/learner-export/buildLearnerExport.js`
**Authorized entrypoint:** `src/lib/learner-export/exportLearnerData.js`
**Route:** `src/app/api/learner-export/route.js`
**Tests:** `src/lib/__tests__/learnerExport.test.js`,
`src/lib/__tests__/exportLearnerData.test.js`

**Error codes** on failure: `EVT_AUTH_001` (not authenticated),
`EVT_AUTH_002` (account suspended), `EVT_ENTITLEMENT_004` (export assembly
error or feature disabled). See
[`docs/API_REFERENCE.md`](API_REFERENCE.md).

### Authorization and scoping (#790)

The export exposes purchase history and PII, so it is scoped strictly to the
**authenticated session user**:

- The caller is resolved from the session (`requireActiveUser`), never from a
  client-supplied header or parameter. A caller can never request another
  user's export.
- Every query (`purchases`, `entitlement_cache`, `refunds`,
  `learner_progress`) is filtered by the session user's wallet address.
- Suspended accounts are rejected with `403`.
- The endpoint is rate-limited (10 requests/minute) and returns
  `Cache-Control: no-store`.

### Retention (#790)

Exports are **generated on demand and never stored server-side**, so there is
no artifact to expire. Each export carries a `retention` block stating this
explicitly:

```json
"retention": {
  "artifactLifetime": "ephemeral",
  "generatedAt": "2026-01-15T10:00:00.000Z",
  "expiresAt": null,
  "policy": "Exports are generated on demand and are not retained on the server. Download and store your export locally; it is not recoverable once lost."
}
```

### Feature flag (#797)

The endpoint is gated behind `FEATURE_FLAG_LEARNER_DATA_EXPORT`. When the flag
is off (the safe default) the endpoint returns `503` — missing configuration
falls back to the safer behavior of not exposing data. See
[feature flags](feature-flags.md).

### Tests (#790)

`src/app/api/__tests__/learnerExport.route.test.js` covers:

- **Denied export** — unauthenticated callers get `401`, suspended accounts get
  `403`, and a disabled feature flag returns `503`.
- **Empty export** — a user with no purchases gets a valid empty document.
- **Large export** — 250 purchases are all included and the document validates.
- **Out-of-scope** — a caller only ever receives their own data; entitlements,
  refunds, and progress are scoped to the session user as well.

### Authorized export entrypoint (#838)

`buildLearnerExport()` is a pure assembler — it trusts the collections it is
given, so the caller must prove the requester may see the subject's records.
`exportLearnerData({ requester, subject, ... })` centralises that proof as the
authorized entrypoint for programmatic callers. The HTTP route
(`GET /api/learner-export`) applies the same self-export-only policy inline by
resolving the session user and scoping every query to that wallet.

**Authorization rules:**

| Requester                                          | Result                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| Owns the subject (`requester` wallet === subject)  | Allowed — scope `self`. May request `redaction: full` (own PII).       |
| Role `admin` or `support`, or `admin:access`       | Allowed — scope `privileged`, for support/dispute/compliance workflows. |
| Any other authenticated or anonymous requester     | Denied — throws `ExportAuthorizationError` **before** any record is read. |

A denied export throws the typed `ExportAuthorizationError` with `code`
(`EXPORT_UNAUTHENTICATED` → 401, `EXPORT_FORBIDDEN` → 403) and never returns a
document. The error is thrown before assembly, so a denied request cannot leak
data even partially.

**Privacy guarantees:**

- Cross-user (`privileged`) exports are capped at `partial` redaction — another
  learner's `email` and `fullName` are always `null`, even if `full` is asked
  for. Only a learner's own export may emit PII.
- Every user-owned collection (`purchases`, `entitlements`, `refunds`,
  `progressRecords`) is filtered to rows owned by the subject as defense in
  depth. Unattributable or foreign rows are dropped, never included, so a
  miscalled query cannot exfiltrate another learner's data.

**Self-describing metadata** — every export carries `schemaVersion`
(`1.0.0`) and `generatedAt` (ISO 8601), plus the `retention` block described
above. The wrapper adds an `authorization` block recording the scope, the
effective redaction level, and the audit reason. Schema compatibility rules are
unchanged: consumers ignore unknown top-level keys.

**Tests (`src/lib/__tests__/exportLearnerData.test.js`)** cover the four
acceptance cases — valid, empty, denied, and a 4,000-purchase large export —
plus the cross-user PII cap and foreign-row filtering.
