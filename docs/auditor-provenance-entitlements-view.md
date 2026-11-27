# Auditor View: Material Provenance and Entitlement Changes (#1213)

## Overview

EduVault enables educators and learners to transact digital educational resources with verified provenance and durable entitlements.
The **Auditor View** (`/admin/auditor` and `GET /api/admin/auditor`) allows compliance officers, auditors, and administrators to inspect:
1. **Material Provenance**: Full ancestry trails of bulk imports, original listings, and derivative works (forks/adaptations) with cryptographic parent linkage and transform version stamps.
2. **Entitlement Lifecycle Changes**: Real-time audit logs of access entitlements granted, revoked, transferred, or refunded, cross-referenced with on-chain Stellar transactions and receipt proofs.
3. **Cryptographic Integrity & Evidence Exports**: Integrity auditing that flags broken ancestry links or tampered entries, supporting offline JSON and CSV evidence bundles.

---

## Authorization

- Requires authentication and one of the following roles or permissions:
  - Roles: `admin`, `auditor`, `compliance_officer`
  - Permissions: `audit:read`, `provenance:read`, `entitlements:read`, or `admin:manage`.
- Unauthorized requests return HTTP `403 Forbidden` (`AUTH_FORBIDDEN`) or `401 Unauthorized` (`AUTH_UNAUTHENTICATED`).

---

## API Endpoints

### `GET /api/admin/auditor`

Query parameters:
- `materialId`: (optional) Filter by specific material ID.
- `buyerAddress`: (optional) Filter entitlement records by buyer wallet address.
- `kind`: (optional) Filter provenance by kind (`original`, `import`, `derived`).
- `importBatchId`: (optional) Filter by bulk import batch identifier.
- `actor`: (optional) Filter by actor wallet address.
- `limit`: (optional) Max records to retrieve (default: 50, max: 1000).
- `format`: (optional) Set to `csv` to stream a CSV file attachment.

Response structure:
```json
{
  "success": true,
  "data": {
    "provenance": {
      "rows": [
        {
          "materialId": "65a1...",
          "title": "Calculus Notes",
          "provenanceKind": "import",
          "importBatchId": "batch-2026-01",
          "actorAddress": "GB...",
          "revisionCount": 0,
          "transformVersion": "import@1"
        }
      ],
      "summary": { "total": 1, "imported": 1, "derived": 0, "native": 0 }
    },
    "entitlements": {
      "rows": [
        {
          "entitlementId": "65b2...",
          "materialId": "65a1...",
          "buyerAddress": "GA...",
          "active": true,
          "status": "active",
          "grantedAt": "2026-01-02T12:00:00Z",
          "revokedAt": null,
          "transactionHash": "0x...",
          "hasReceiptProof": true
        }
      ],
      "totalCount": 1,
      "activeCount": 1,
      "revokedCount": 0
    },
    "integrity": {
      "verified": true,
      "totalRecords": 1,
      "brokenChains": 0,
      "issues": []
    }
  }
}
```

---

## Auditor UI Portal (`/admin/auditor`)

- **Overview Cards**: Key figures for total materials, active entitlements, revoked entitlements, and cryptographic integrity health.
- **Search & Filter Bar**: Filter by Material ID, Buyer Wallet Address, Provenance Kind, or Import Batch.
- **Tab Navigation**:
  - *Material Provenance*: Tabular view with ancestry links, import batch tags, and revision counts.
  - *Entitlement Changes*: Detailed lifecycle log showing buyer wallets, grant dates, revocation reasons, and transaction links.
  - *Integrity Verification*: Cryptographic audit reporting showing unbroken hash ancestry or flagging orphan derivatives.
- **Export Capabilities**:
  - `Export CSV`: Downloads spreadsheet-friendly CSV table.
  - `Export Evidence Bundle`: Downloads raw JSON bundle with complete audit metadata.
- **Reliability & Retry**: Includes inline error banners with retry buttons on transient network dropouts.
