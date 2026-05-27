# Soroban Threat Model

## Overview
This document outlines the threat model for the `MaterialRegistry` and `PurchaseManager` contracts in the EduVault platform. It identifies potential risks, mitigations, and assumptions for secure operation.

## Threats and Mitigations

### 1. Unauthorized Material Registration
**Threat**: An attacker registers materials without proper authorization.
**Mitigation**: The `register_material` function enforces creator authentication using Soroban's `require_auth`.

### 2. Duplicate Material IDs
**Threat**: Collisions in `material_id` generation could overwrite existing materials.
**Mitigation**: The `material_id` is derived using a combination of the creator's address and a nonce, ensuring uniqueness.

### 3. Invalid Metadata
**Threat**: Materials with empty or excessively long metadata URIs could disrupt the system.
**Mitigation**: Metadata URIs are validated for non-emptiness and length constraints.

### 4. Invalid Asset Quotes
**Threat**: Asset quotes with negative amounts or duplicate assets could be registered.
**Mitigation**: Asset quotes are validated to ensure positive amounts and unique assets.

### 5. Invalid Payout Shares
**Threat**: Payout shares exceeding 10,000 basis points or containing duplicate recipients could be registered.
**Mitigation**: Payout shares are validated to ensure they sum to exactly 10,000 basis points and have unique recipients.

### 6. Unauthorized Updates
**Threat**: An attacker modifies material sale terms or status without authorization.
**Mitigation**: Updates to sale terms and status require creator authentication.

### 7. Replay Attacks
**Threat**: Reuse of valid transactions to perform unauthorized actions.
**Mitigation**: Nonces and ledger sequence numbers are used to prevent replay attacks.

### 8. Asset Transfer Failures
**Threat**: Failures in asset transfers could result in incomplete purchases.
**Mitigation**: Asset transfers and entitlement writes are atomic; failures revert the entire transaction.

### 9. Indexer Lag
**Threat**: Delays in the indexer could cause stale or inconsistent data.
**Mitigation**: Entitlement verification falls back to direct contract queries when the indexer is lagging.

### 10. Admin Abuse
**Threat**: Misuse of admin privileges to modify platform configuration or asset policies.
**Mitigation**: Admin actions are limited to asset allowlist updates, treasury recipient changes, and platform fee adjustments within a capped range.

## Assumptions
- Stellar finality is sufficient for entitlement indexing.
- Off-chain metadata and file storage are trusted to remain consistent with on-chain references.
- The platform operates in a trusted environment where contract upgrades follow migration-driven processes.

## Future Considerations
- Support for refunds and entitlement revocation.
- Enhanced logging and monitoring for suspicious activity.
- Integration with external security audits.

## Conclusion
This threat model provides a foundation for secure operation of the `MaterialRegistry` and `PurchaseManager` contracts. Regular reviews and updates are recommended as the platform evolves.