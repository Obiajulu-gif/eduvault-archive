# Maintainer Operational Health Dashboard & Indicators

## Overview
The Maintainer Operational Health system aggregates indicators across storage workflows, purchase reconciliation, outbox processing, and user-impacting incidents to ensure maintainers can rapidly detect, diagnose, and triage production exceptions.

## Actionable Categories

1. **Unresolved Failures & Exceptions**
   - **Failed Outbox Messages**: Events that failed to publish/deliver to external processors (`outbox` collection).
   - **Indexer Deadletters**: Soroban or Stellar blockchain events that failed processing and require manual review (`indexer_deadletters` collection).
   - **Failed Refunds**: Marketplace refund transactions that errored during execution (`refunds` collection).
   - **Quarantined Files**: Content flagged during virus or malicious file scanning (`quarantineState: 'infected'`).

2. **Stale Jobs**
   - **Stale Checkout Intents**: Buyer purchase intents remaining in `pending` status past the stale threshold (`checkout_intents` collection).
   - **Long-Running Storage Jobs**: Maintenance or pin verification workers exceeding execution timeouts (`storage_jobs` collection).

3. **Reconciliation Drift**
   - **Purchase On-Chain Drift**: Database records indicating completed purchases where on-chain verification diverged or failed.
   - **Unverified Pins**: Pinned IPFS assets awaiting or failing integrity and replication checks.

4. **User-Impacting Incidents**
   - **Access Denial Spikes**: Download denials due to entitlement check failures in the last 24 hours.
   - **Suspended Users**: Moderated or suspended creator accounts with listings hidden from discovery.

## Severity Levels

Each category reports a count and a severity derived from the count and age of the unresolved records:

| Severity | Trigger | Meaning |
| --- | --- | --- |
| `critical` | Unresolved count > 0 and oldest unresolved record is older than 24 hours, or any user-impacting incident is present | Customer-facing breakage or data loss risk; page on-call |
| `warning` | Unresolved count > 0 and oldest record is between 1 and 24 hours old | Retry budget exhausted or slowing; triage today |
| `info` | Unresolved count > 0 and all records are less than 1 hour old | Newly observed failure; monitor for escalation |
| `okay` | Unresolved count is 0 | No action needed |

Age is measured from the record's failure timestamp (`failedAt`, `errorAt`, `lastAttemptAt`, or equivalent) to the report generation time. The report also includes a seven-day failure trend per category so maintainers can distinguish a one-off incident from a regression.

## Report Shape

The report is a single JSON object with a `totals` summary, a `categories` array, and a `trends` array. Each category entry includes:

- **`id`**: Stable machine readable identifier (for example `failed_outbox`).
- **`collection`**: Source collection or query scope.
- **`count***: Number of unresolved records.
- **oldestAgeHours**: Age of the oldest unresolved record in hours.
- **`severity`**: One of `critical`, `warning`, `info`, `okay`.
- **`sampleIds`**: Up to five record identifiers (redacted) for investigation.
- **`investigationUrl`**: Deep link into the admin UI for the collection and filter.

## Sensitive Data Redaction
Maintainer summaries and sample exception records automatically redact sensitive information before presentation:
- Stellar private keys (`S` 56-char keys`) -> `[REDACTED_STELLAR_SECRET_KEY]`
- EVM private keys (`0x` 32-byte keys`) -> `[REDACTED_EVM_PRIVATE_KEY]`
- Auth headers, JWT secrets, passwords -> `[REDACTED]`
- Email addresses -> j***@domain.com

## Role-Scoped Maintainer Action Approval

High-impact maintainer actions require a valid, scoped approval record before they are allowed to execute. Approvals are stored in the `approvals` collection and are checked by the `assertApproval` helper in `services/approvals.js`.

### Protected Actions

| Action ID | Description | Required Scope |
| --- | --- | --- |
| `refund.execute` | Execute a marketplace refund transaction | `refunds` |
| `quarantine.release` | Release a file from quarantine | `quarantine` |
| `user.suspend` | Suspend a creator account | `users` |
| `outbox.replay` | Replay a failed outbox message | `outbox` |
| `indexer.replay` | Replay an indexer deadletter | `indexer` |

### Approval Record Shape

Each approval document in the `approvals` collection must include:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string | yes | Protected action identifier (e.g. `refund.execute`) |
| `scope` | string | yes | Resource scope the approval applies to (e.g. `refunds`) |
| `actor` | string | yes | Maintainer identity that granted the approval |
| `reason` | string | yes | Human-readable justification for the approval |
| `expiresAt` | Date | yes | Instant after which the approval is invalid |
| `createdAt` | Date | yes | Instant the approval was created |

### Validation Rules

An approval is considered valid only when all of the following hold:

1. An approval document exists for the requested `action`.
2. The approval `scope` exactly matches the scope required by the action.
3. The approval `actor` matches the calling maintainer.
4. The approval `expiresAt` is in the future.
5. The approval `reason` is non-empty.

Attempts to execute a protected action without a valid approval are rejected with an `unscopedApproval` or `missingApproval` error and recorded in the audit log.

### Audit Records

Every protected action attempt (accepted or rejected) writes an audit record to the `audit_logs` collection with:

- `action`: the protected action identifier.
- `scope`: the resource scope the action targeted.
- `actor`: the maintainer identity that attempted the action.

- `approvalId`: the `_id` of the approval document used, or `null` when none was found.
- `reason`: the approval reason, or `null` when no approval was found.
- `outcome`: `accepted` or `rejected`.
- `rejectionReason`: `missingApproval`, `expiredApproval`, `wrongScope`, `wrongActor`, or `missingReason`.
- `timestamp`: the instant the attempt was made.

### Approval Administration

Approvals are created and inspected through the admin API:

```http
POST /api/admin/approvals
Content-Type: application/json
Cookie: auth_token=<admin-jwt>

{
  "action": "refund.execute",
  "scope": "refunds",
  "actor": "maintainer@admin",
  "reason": "Customer reported duplicate charge on order 42.",
  "expiresAt": "2025-01-01T00:00:00Z"
}
```

```http
GET /api/admin/approvals?action=refund.execute&scope=refunds
Cookie: auth_token=<admin-jwt>
```

## Accessing the Health Dashboard

### 1. API Endpoint
```http
GET /api/admin/health-dashboard
Headers:
  Cookie: auth_token=<admin-jwt>
  # or
  x-admin-token: <ADMIN_API_TOKEN>
```

### 2. CLI Report Tool
```bash
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/maintainer-health-report.mjs

```

## Testing

The approval flow is covered by `tests/approvals.test.js`, which exercises the four required cases:

- Valid approval -> action allowed.
- Missing approval -> `approvalRequired` error.
- Expired approval -> `approvalExpired` error.
- Wrong-scope approval -> `wrongScope` error.

Run the tests with:

```bash
node --test tests/approvals.test.js
```

### 3. Validation Command
Run the automated tests that assert counts match the fixtures and that sensitive details are redacted:

```bash
node --test tests/maintainer-health-report.test.mjs
```

The test suite loads the fixtures in `tests/fixtures/maintainer-health/` and asserts:

- Every category count equals the number of matching unresolved records.
- Severity levels follow the table above.
- Stellar secrets, EVM private keys, auth headers, and email addresses are redacted in `sampleIds` and any free-text fields.
