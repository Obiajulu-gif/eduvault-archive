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
**Route:** `src/app/api/learner-export/route.js`
**Tests:** `src/lib/__tests__/learnerExport.test.js`

**Error codes** on failure: `EVT_AUTH_001` (not authenticated),
`EVT_ENTITLEMENT_004` (export assembly error). See
[`docs/API_REFERENCE.md`](API_REFERENCE.md).
