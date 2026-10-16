# Partial-Failure Dashboard & Resolution System

## Overview

EduVault operates asynchronous jobs, off-chain/on-chain integration boundaries, and critical user operations. The Partial-Failure Dashboard (`/admin/partial-failures`) provides operations teams with a centralized, domain-aware operational center to:

1. Filter unresolved partial failures across domains (`async_jobs`, `integrations`, `user_operations`).
2. Inspect underlying error causes and redacted context.
3. Distinguish between operations that can be automatically retried versus operations that require explicit user action (e.g. invalid wallet trustline, re-authentication, clean file re-upload).
4. Trigger safe, idempotent retries.
5. Manually resolve or abandon failures with full append-only audit logging.

---

## Domain Architecture

| Domain | Underlying Source Collections | Example Operations | Safe Auto-Retry |
| :--- | :--- | :--- | :--- |
| **`async_jobs`** | `background_jobs` | `storage:garbage-collection`, `search:reindex`, `report:generation` | Yes (resets status to `pending` with backoff) |
| **`integrations`** | `side_effect_outbox`, `indexer_deadletters` | `outbox:email_receipt`, `indexer:stellar_sync`, `webhook:delivery` | Yes (clears lock lease, resets attempt count) |
| **`user_operations`** | `refunds`, `materials`, `checkout_intents` | `payout:refund_execution`, `storage:content_quarantine`, `purchase_entitlement` | Conditional (requires user action if destination is misconfigured) |

---

## Operational Edge Cases & Failure Modes

### 1. Concurrent Worker Retries
- **Failure Mode**: Two operators or an operator and background daemon attempt to retry the same failed job concurrently.
- **Handling**: Updates are atomic using MongoDB find-and-modify semantics. State transitions to `retrying` immediately, and leases prevent multiple workers from claiming the same execution.

### 2. User Action Required
- **Failure Mode**: A refund fails on Stellar because the recipient account does not exist or lacks an asset trustline. Retrying automatically will continuously fail and consume contract gas.
- **Handling**: The system flags `requiresUserAction: true` and `canRetrySafely: false` with guidance:
  `"User destination account is invalid or unable to receive tokens. Please ask user to verify receiving trustline."`
  The operator is prevented from executing automated retries until user action is confirmed.

### 3. Poison Pill / Corrupted Payload
- **Failure Mode**: An unparseable or malicious payload enters an async job queue.
- **Handling**: The operator inspects the redacted error cause and can click `Abandon`. An audit record is logged with the operator's rationale.

---

## Rollback & Recovery Procedures

1. **Reverting an Accidental Resolution**:
   If an operator accidentally marks an unresolved incident as `resolved`, re-query using `?status=resolved` and trigger `POST /api/admin/partial-failures/retry`.
2. **Audit Verification**:
   Every operator retry and resolution event emits an immutable entry to `audit_ledger` with `operationId`, actor address, and target reference.
