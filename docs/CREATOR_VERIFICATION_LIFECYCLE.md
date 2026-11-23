# Creator Verification Lifecycle, Expiry, and Revocation (#1185)

## Overview
Creator verification in EduVault establishes identity trust across the educational content marketplace, unlocking verified badge display on author profiles (`CreatorCard.jsx`) and published content (`ResourceStatusBadge.jsx`).

This document specifies the end-to-end verification lifecycle, expiration detection, administrative revocation, and emergency recovery/rollback procedures.

## Verification Lifecycle States

| State | Definition | Trigger / Transition | Badge Status |
| --- | --- | --- | --- |
| `pending` | Application submitted by creator, awaiting review | Initial application submission | Unverified |
| `active` | Approved by administrator with valid expiration | Admin approval via `/api/admin/verification` (`action: "approve"`) | **Verified** |
| `expired` | Verification period elapsed (`expiresAt <= now`) | Background sweep or query-time expiration evaluation | Unverified |
| `revoked` | Administratively withdrawn due to policy violations, disputes, or security | Admin revocation via `/api/admin/verification` (`action: "revoke"`) | Unverified |
| `rejected` | Application declined during initial review | Admin rejection (`action: "reject"`) | Unverified |

## Guarantees & Contracts

1. **Authorization Boundaries**:
   - All lifecycle transitions require explicit administrator/operator authorization (`admin:verification:manage` permission or `admin`/`operator`/`system` roles).
   - Unauthorized attempts fail closed with `AppError("AUTH_FORBIDDEN")` (HTTP 403).

2. **Temporal Validity (`isCreatorVerified`)**:
   - Verification is actively recognized iff `status === 'active'` AND (`expiresAt` is absent or `new Date(expiresAt) > now`).
   - Expired or revoked credentials immediately suppress the `Verified` badge on published materials and creator profile cards.

3. **Mandatory Revocation Reasons**:
   - Revocation requires a non-empty audit reason (`REVOCATION_REASONS`: `policy_violation`, `fraud_suspected`, `voluntary`, `administrative`, `credential_expired`).
   - Every revocation appends an immutable audit record to `auditLedger` (`verification.revoke`).

4. **Idempotency & State Consistency**:
   - Calling revoke on an already-revoked creator is rejected with `AppError("VALIDATION_FIELD")` (HTTP 400).
   - Denormalized credentials stored on `materials` are synchronized in the same operation.

## Operational Edge Cases & Recovery

| Operational Scenario | Behavior | Recovery / Rollback Runbook |
| --- | --- | --- |
| **Accidental Revocation** | Profile downgraded to `individual` and credential marked `revoked`. | Call `rollbackVerificationAction(db, report.rollbackSnapshot)` to restore prior credential and profile type atomically. |
| **Appeal & Reinstatement** | Creator disputes revocation and passes appeal process. | Invoke `reinstateCreatorVerification({ db, target, actor, durationDays: 365 })` to re-activate credential with fresh expiration. |
| **Transient Write Failures** | Network or lock conflict during profile/application update. | Operations automatically retry up to `maxRetries` (default: 2) with bounded linear backoff. |
| **Stale Active Expiration** | Creator credential has expired but status is still marked `active`. | Handled automatically at evaluation time (`isCreatorVerified` checks `expiresAt`). Run `expireStaleCreatorVerifications({ db })` for persistent cleanup. |

## Administrative API Reference

### POST `/api/admin/verification`

#### 1. Revoke Verification
```json
{
  "action": "revoke",
  "applicationId": "app_12345",
  "reason": "policy_violation"
}
```

#### 2. Run Expiration Sweep
```json
{
  "action": "expire_stale"
}
```

#### 3. Reinstate Verification
```json
{
  "action": "reinstate",
  "applicationId": "app_12345",
  "durationDays": 365
}
```
