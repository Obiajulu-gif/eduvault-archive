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
- Email addresses -> `jXxx@domain.com`

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

### 3. Validation Command
Run the automated tests that assert counts match the fixtures and that sensitive details are redacted:

```bash
node --test tests/maintainer-health-report.test.mjs
```

The test suite loads the fixtures in `tests/fixtures/maintainer-health/` and asserts:

- Every category count equals the number of matching unresolved records.
- Severity levels follow the table above.
- Stellar secrets, EVM private keys, auth headers, and email addresses are redacted in `sampleIds` and any free-text fields.
