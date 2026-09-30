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

## Sensitive Data Redaction
Maintainer summaries and sample exception records automatically redact sensitive information before presentation:
- Stellar private keys (`S...` 56-char keys) -> `[REDACTED_STELLAR_SECRET_KEY]`
- EVM private keys (`0x...` 32-byte keys) -> `[REDACTED_EVM_PRIVATE_KEY]`
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
MONGODB_URI="mongodb://localhost:27017/eduvault" node scripts/maintainer-health-report.mjy
```

## Historical Trend Aggregation

Maintainers can request historical trend data for a creator across usage, failures, recovery actions, and important domain activity. The aggregation is deterministic for a given date range and window, so fixture data produces stable output suitable for regression testing.

### Metrics

| Metric | Description |
| --- | --- |
| `usage` | Material views/downloads and completed purchases attributed to the bucket. |
| `failures` | Failed purchases, outbox messages, indexer deadletters, and failed refunds. |
| `recoveryActions` | Retried/recovered outbox messages, recovered refunds, and recovery-status purchases. |
| `domainActivity` | Reviews and saves attributed to material creation date. |

### Aggregation Windows

- `day` (default): UTC day buckets (`YYYY-MM-DD`).
- `week`: UTC week buckets aligned to Monday.
-x `month`: UTC month buckets (`YYYY-MM`).

### API Endpoint

```http
GET /api/creator/analytics/trends?from=2024-06-01&to=2024-06-30&window=day
Headers:
  Cookie: auth_token=<creator-jwt>
```

Optional query parameters:

- `from`, `to`: ISO dates. Defaults to the last 30 days.
- `window`: `one of `day`, `week`, `month`.
- `format=csv`: Returns a CSV export instead of JSON.

The JSON response includes a `schemaVersion` field (currently `eduvault.trends.v1`) along with `buckets`, `totals`, and a `redaction` block describing the privacy policy applied to the response.

### Privacy & Redaction

Private materials contribute only to aggregate totals. The response never includes per-material identifiers for private materials, only a `privateMaterialCount` summary in `totals`. The `redaction` block is always present with `applied: true` and the current policy name.

### Testing

```bash
node --test tests/analytics/trends.test.mjs
```

The test suite covers date range resolution, bucket enumeration for day/week/month windows, empty data, large result sets, and CSV export shape.
