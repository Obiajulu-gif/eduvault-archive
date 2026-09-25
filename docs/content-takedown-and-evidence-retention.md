# EduVault Content Takedown, Buyer Access, Refund, and Evidence Retention Policy (#705)

## 1. Executive Summary

This policy establishes operational, cryptographic, and legal guidelines for managing content takedowns on the EduVault platform. It defines takedown lifecycle states, buyer access retention vs. immediate revocation rules, escrow refund automation, and secure evidence preservation standards without public data exposure.

---

## 2. Content Takedown Lifecycle States

| State | Catalog Visibility | New Purchases | Existing Buyer Access | Escrow / Payout Status |
| :--- | :--- | :--- | :--- | :--- |
| **`ACTIVE`** | Publicly Listed | Allowed | Full Access via Active Entitlement | Normal Settlement |
| **`FLAGGED_REVIEW`** | Search De-boosted | Allowed | Full Access | Payouts Monitored |
| **`TAKEDOWN_SUSPENDED`** | Hidden from Catalog | Blocked | Suspended (if malware/security risk) or Maintained (if copyright dispute) | Escrow Locked |
| **`TAKEDOWN_CONFIRMED`** | Removed from Platform | Blocked | Revoked with Full Refund Entitlement | Escrow Forfeited to Buyer Refunds |
| **`REINSTATED`** | Restored to Catalog | Resumed | Full Access Restored | Normal Settlement Resumed |

---

## 3. Buyer Access & Rights Policy Under Takedown

When content is taken down, existing buyer entitlements follow a categorized risk policy:

### A. Severe Security, Malware, or Illegal Material
- **Access Rule**: **Immediate Revocation**. All download capabilities and API asset generation tokens are disabled immediately to protect buyer environments.
- **Refund Rule**: **Automatic Full Refund**. Smart contract triggers automated return of funds from escrow/vault to buyer wallets.
- **Library State**: Material card in `/dashboard/purchases` displays status `"Revoked: Security Violation"` with refund transaction hash.

### B. Copyright, Trademark, or DMCA Disputes
- **Access Rule**: **Snapshot Access Retention (30-Day Window)**. Existing purchasers retain the right to download the immutable version snapshot (`get_purchase_snapshot`) they acquired prior to the takedown notice, unless a court order mandates complete deletion.
- **Refund Option**: Buyers may choose between retaining download access or requesting a 1-click dispute refund while the creator's payout remains frozen in escrow.

### C. Voluntary Creator Takedown or Deprecation
- **Access Rule**: **Permanent Buyer Grandfathering**. Takedown only removes public catalog purchase availability. Existing buyers maintain lifetime entitlement to their purchased snapshot version.

---

## 4. Refund & Dispute Settlement Workflow

1. **Takedown Notice Triggered**: Moderator or automated detection places material into `TAKEDOWN_SUSPENDED`.
2. **Escrow Lock**: Soroban `purchase-manager` contract locks pending creator payout distributions for the affected `material_id`.
3. **Buyer Notification**: Impacted purchasers receive automated wallet notifications with options for automated refund claims.
4. **Dispute Resolution**:
   - If upheld (`TAKEDOWN_CONFIRMED`): Locked escrow funds are allocated to buyer refund claims via `refund_purchase_to_buyer()`.
   - If counter-notice succeeds (`REINSTATED`): Escrow lock is released, and normal catalog operations resume.

---

## 5. Audit Evidence Retention & Legal Preservation

To comply with statutory evidence preservation requirements (e.g. DMCA, consumer protection) while preventing public leakage:

- **Immutable Audit Snapshot**: The system captures `content_hash`, IPFS/Arweave storage CID, takedown reason code, reporter attestation, and moderator timestamp into a private audit ledger (`audit-ledger.md`).
- **Access Isolation**: Audit evidence is strictly accessible to verified platform compliance officers and legal counsel under access reason code `admin_review` or `legal_compliance`.
- **Retention Period**: Audit evidence records are retained for a minimum of 7 years in immutable, encrypted cold storage.
- **Zero Public Exposure**: Public API endpoints for materials and search queries return `404 Not Found` or `410 Gone` with sanitized reason codes, ensuring defamatory or infringing material is never served publicly.

---

## 6. Reinstatement Procedure

In the event of a successful counter-notice or resolved dispute:
1. Legal and compliance team approves reinstatement.
2. Status transitions from `TAKEDOWN_SUSPENDED` to `REINSTATED`.
3. Material re-appears in public search and catalog listings.
4. Buyer download permissions are fully re-enabled without requiring new transaction signatures.
