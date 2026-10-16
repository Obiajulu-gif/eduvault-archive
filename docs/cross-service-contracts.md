# Cross-Service Contract Map & Boundary Registry (#960)

## Overview

EduVault operates as a high-integrity educational content marketplace built on Stellar and Next.js. Cross-service interactions between the API layer, background workers, indexer, search projections, and financial engines communicate via structured domain events.

This document establishes the machine-readable contract registry (`src/lib/backend/eventContractMap.js`), mapping all domain events, integration boundaries, producers, consumers, typing schemas, and failure behaviors.

---

## 1. Domain Event Contract Matrix

| Event Type | Domain | Version | Producers | Consumers | Allowed Failure Strategy |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `purchase.settled` | Marketplace | `1.2.0` | `checkout-api` | `entitlement-worker`, `payout-accrual-worker`, `analytics-collector`, `email-notifier` | Exponential retry (max 5) &rarr; `side_effect_outbox:dead_letter` |
| `refund.processed` | Finance | `1.1.0` | `refund-api` | `entitlement-revoker`, `financial-audit-sink`, `creator-journal` | Exponential retry (max 3) &rarr; `refunds:dead_letter` |
| `payout.settled` | Finance | `1.0.0` | `payout-worker` | `financial-audit-sink`, `notification-worker` | Exponential retry (max 4) &rarr; `payouts:dead_letter` |
| `material.published`| Content | `1.3.0` | `publication-saga` | `search-projection-indexer`, `preview-pipeline`, `provenance-logger` | Exponential retry (max 3) &rarr; `indexer_deadletters` |
| `material.quarantined` | Content | `1.0.0` | `upload-guard`, `admin-moderation-api` | `search-tombstoner`, `delivery-blocker`, `partial-failure-monitor` | Immediate Circuit Break &rarr; `quarantine_urgent_deadletters` |
| `user.role_changed` | Identity | `1.0.0` | `admin-iam-api` | `session-cache-invalidator`, `privileged-audit-sink` | Exponential retry (max 3) &rarr; `admin_audit_deadletters` |
| `indexer.sync_completed` | Indexer | `1.0.0` | `stellar-indexer` | `stale-index-detector`, `operational-health-monitor` | Best effort log only |

---

## 2. Schema Evolution & Versioning Rules

EduVault enforces strict semantic versioning for domain events:

1. **Additive Compatibility (Minor / Patch Bump)**:
   - Producers may add optional fields at any time.
   - Consumers must ignore unknown fields rather than throwing deserialization errors.
   - Schema version increments from `1.x.y` to `1.x+1.0`.

2. **Breaking Changes (Major Bump)**:
   - Renaming or removing fields, or converting optional fields to required, constitutes a breaking change (`2.0.0`).
   - Major version changes require a dual-publish deprecation window of at least two release cycles.
   - Consumers must declare all `supportedVersions` they can accept (e.g., `['1.0.0', '1.1.0', '1.2.0']`).

3. **Field Typing & Validation**:
   - Every contract declares required fields and strict primitive types via `fieldTypes`.
   - `validateEventPayload(eventType, payload, options)` validates events prior to enqueueing or emission.

---

## 3. Failure Behaviors & Dead-Letter Handling

### A. Failure Strategies
- **`retry_then_dead_letter`**: Used for idempotent background operations. The outbox dispatcher retries with exponential backoff (e.g. 1s, 2s, 4s, 8s, 16s). On terminal failure, payload is safely moved to dead-letter queue with stack trace and timestamp.
- **`fail_immediate_circuit_break`**: Used for critical security events (e.g. `material.quarantined`). Fails fast and alerts on-call operators immediately to stop infected content propagation.
- **`best_effort_log_only`**: Used for high-frequency telemetry and health pulses (`indexer.sync_completed`). Drops transient failures to prevent queue starvation.

### B. Idempotency Invariants
- All state-mutating consumers must be strictly idempotent.
- Every event payload carries a unique domain key (`purchaseId`, `refundId`, `payoutId`, `materialId`) used by consumers for de-duplication locks or database upsert constraints.

---

## 4. Operational Edge Cases & Recovery Procedures

### Edge Case 1: Outbox Queue Stagnation / Connection Failure
- **Symptom**: Side-effect outbox table accumulates events with `status: 'pending'` and high retry counts.
- **Resolution**:
  1. Inspect network connectivity to Stellar RPC endpoints or SMTP provider.
  2. Query `GET /api/admin/partial-failures?domain=integrations`.
  3. Trigger bulk safe retry: `POST /api/admin/partial-failures/retry`.

### Edge Case 2: Consumer Contract Deserialization Mismatch
- **Symptom**: Worker crashes with `Invalid type for field` or `Missing required field`.
- **Recovery**:
  1. Inspect dead-letter record in `indexer_deadletters` or `side_effect_outbox`.
  2. Verify producer version vs consumer `supportedVersions`.
  3. If payload was emitted by a legacy producer, deploy consumer with backwards-compatible adapter.
  4. Reprocess the dead-letter queue using `npm run worker:background:reprocess`.

### Edge Case 3: Rollback Procedures
- When rolling back a service deployment:
  - Keep new event consumers active if the database contains events in newer minor versions.
  - In-flight events will continue to be safely processed because all minor version upgrades are additive.
