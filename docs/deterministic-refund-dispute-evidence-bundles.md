# Deterministic Refund Dispute Evidence Bundles

This document describes the design, authorization model, edge cases, recovery/rollback behavior, and migration plan for deterministic refund dispute evidence bundles (`src/lib/refunds/deterministicEvidenceBundle.js`).

## Overview

Refund disputes require portable, tamper-evident evidence bundles that combine:
1. `buyerClaim`
2. `creatorMetadata`
3. `purchaseTransaction`
4. `accessLogs`
5. `entitlementState`

`buildDeterministicDisputeEvidenceBundle` canonicalizes every section using `src/lib/canonical.js`, sorts and deduplicates `accessLogs`, and computes:
- `sectionDigests`: SHA-256 hex digest per section
- `bundleDigest`: SHA-256 hex digest over the canonicalized body (`schemaVersion`, `purchaseId`, optional `disputeId`, `sections`, `sectionDigests`)
- `bundleId`: `rdeb_<first 24 hex chars of bundleDigest>`
- `provenanceSeal` (optional): HMAC-SHA256 signature over `bundleDigest` when a server-side `bundleKey` (>= 32 chars) is supplied

## Authorization Matrix

All operations fail closed via `authorizeDisputeEvidenceAction`:

| Action | Unauthenticated | Buyer (owner) | Creator (material owner) | Auditor / Support | Reviewer | Admin |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `read` | 401 | Allowed | Allowed | Allowed | Allowed | Allowed |
| `build` | 401 | Allowed | 403 | 403 | Allowed | Allowed |
| `attach` | 401 | Allowed while `opened` only | 403 | 403 | Allowed while `opened`/`reviewing` | Allowed while `opened`/`reviewing` |
| `rollback` | 401 | 403 | 403 | 403 | 403 | Allowed (except `executed`) |

## Edge Cases

- **Key and array ordering**: Object keys are sorted lexicographically and normalized. `accessLogs` are sorted by `(timestamp ASC, action ASC, status ASC, canonical JSON)` and exact duplicates are deduplicated before hashing.
- **Numeric and Unicode equivalence**: `150`, `150.0`, and `"150.00"` normalize to the same canonical number; strings are NFC-normalized with collapsed whitespace; `assetCode` is uppercased.
- **Idempotent retries**: Re-attaching semantically identical evidence to a dispute yields the same `bundleDigest` and returns `{ success: true, idempotent: true }` without mutating the document or appending duplicate history entries.
- **Conflicting retries**: Re-attaching different evidence fails closed with `409 evidence_bundle_conflict` unless an `admin` or `reviewer` explicitly passes `allowSupersede: true` while the dispute is in `opened` or `reviewing` state.
- **Terminal / locked states**: Once a dispute transitions to `approved`, `denied`, or `executed`, attaching or superseding evidence is rejected with `409 dispute_evidence_locked`.
- **Concurrent mutations**: Updates guard on `status` and `deterministicEvidence.revision`, returning `409 concurrent_mutation` if another writer modified the dispute concurrently.

## Recovery and Rollback Behavior

- **Supersede snapshot**: When an `admin` or `reviewer` supersedes an existing bundle (`allowSupersede: true`), the previous bundle is preserved in `deterministicEvidence.previousSnapshot`.
- **Rollback (`rollbackDeterministicEvidenceBundle`)**:
  - Restricted to `admin` actors.
  - Blocked once a dispute is `executed` (`409 cannot_rollback_executed_dispute`) to preserve financial audit finality.
  - Restores `previousSnapshot` (and `evidenceBundle`) if rolling back revision > 1, or clears `deterministicEvidence` if rolling back revision 1.
  - Appends an immutable `evidence_bundle_rolled_back` entry to `dispute.history` with `rolledBackBundleId`, `rolledBackDigest`, `restoredBundleId`, `actor`, and `reason`.

## Contract Preservation & Migration Plan

- **Zero breaking changes**: All existing exports and signatures in `src/lib/refunds/disputeWorkflow.js` (`validateEvidenceBundle`, `openDispute`, `transitionDisputeStatus`, `executeDisputeRefund`) are preserved unchanged.
- **Backfilling legacy disputes**: Existing dispute documents without `deterministicEvidence` remain readable and valid. Operators can backfill them in-place by calling `attachDeterministicEvidenceBundle` with the dispute's existing `evidenceBundle`; because the operation is idempotent, backfill jobs can be safely retried.
