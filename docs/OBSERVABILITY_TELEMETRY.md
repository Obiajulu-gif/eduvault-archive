# Observability Telemetry

Issue #788: emit structured telemetry for latency, failure rate, and
business-critical conversion points across EduVault's core operations.

The implementation is dependency-free and lives in
[`src/lib/monitoring/telemetry.js`](../src/lib/monitoring/telemetry.js).
It complements the partial-failure dashboard
([`docs/PARTIAL_FAILURE_DASHBOARD.md`](./PARTIAL_FAILURE_DASHBOARD.md)),
which tracks operations stuck between internal state and external systems.
This module is the general, high-volume latency/failure/conversion signal.

## Instrumented operations

Every record names the operation and the actor type that triggered it.

| Operation | Actor | Call site | What it measures |
| --- | --- | --- | --- |
| `purchase.complete` | `user` | `src/app/api/purchase/route.js` | Buyer completes or re-confirms a paid purchase |
| `checkout.initiate` | `user` | `src/app/api/checkout/initiate/route.js` | Checkout intent creation (tax, trustline, discount) |
| `material.upload` | `creator` | `src/app/api/upload/route.js` | Creator uploads and pins a learning material |
| `material.download` | `user` | `src/app/api/download/route.js` | Buyer requests a signed download capability |
| `material.deliver` | `user` | `src/app/api/materials/deliver/[id]/route.js` | Entitlement-checked material file delivery |
| `wallet.fetch_balances` | `user` | `src/lib/wallet/balance.js` | Stellar wallet balance snapshot load |
| `indexer.ingest` | `system` | `src/app/api/indexer/route.js` | Stellar indexer batch ingest |

The canonical list is exported as `CORE_OPERATIONS` and asserted by
`src/lib/monitoring/__tests__/telemetry.test.js` (requires at least five).

## Field schema

Every record carries this fixed field set — `validateTelemetryRecord()` (and
the throwing `assertTelemetryRecord()`) enforce it in tests:

| Field | Type | Description |
| --- | --- | --- |
| `operation` | string | Stable operation name, e.g. `purchase.complete` |
| `actorType` | string | One of `user`, `creator`, `buyer`, `system`, `worker`, `service`, `anonymous` |
| `result` | string | `success` or `failure` |
| `latencyMs` | number | Wall-clock duration in milliseconds (3-decimal precision) |
| `correlationId` | string | Request/operation correlation id (header, async context, or uuid) |
| `timestamp` | string | ISO-8601 emission time |
| `schemaVersion` | number | Currently `1` |

Optional, allow-listed fields:

| Field | Type | Description |
| --- | --- | --- |
| `metadata` | object | Caller-supplied safe context (redacted — see below) |
| `errorCode` | string | Machine-readable failure code |
| `error` | object | `{ name, code, message }` for thrown failures (message masked) |
| `metric` / `metricType` / `value` | string/string/number | Present on `recordMetric()` records |

Records are emitted as single-line JSON under a stable marker:

```json
{
  "eduvault.telemetry": true,
  "operation": "purchase.complete",
  "actorType": "user",
  "result": "success",
  "latencyMs": 42.318,
  "correlationId": "3d1b...",
  "timestamp": "2026-10-01T10:00:00.000Z",
  "schemaVersion": 1
}
```

## Metric names

Counters/gauges are emitted with `recordMetric(name, fields, options)`. Use
dotted, lower-case names:

- `conversion.purchase` — successful purchase completions
- `conversion.checkout_initiate` — checkout intents created
- `upload.material_pinned` — material uploads pinned to IPFS
- `download.capability_issued` — download capabilities issued
- `delivery.material_granted` — entitlement-checked deliveries
- `wallet.balance_loaded` — balance snapshots loaded
- `indexer.batch_applied` — indexer batches applied

## Example dashboard queries

The module emits pino JSON, so the examples below assume a Loki-style
log backend. Adapt the field names for your aggregator.

**P95 latency per operation (last 15m)**

```logql
quantile_over_time(0.95,
  {app="eduvault"} | json | eduvault_telemetry="true"
  | unwrap latencyMs [15m]
) by (operation)
```

**Failure rate per operation**

```logql
sum by (operation) (count_over_time(
  {app="eduvault"} | json | eduvault_telemetry="true" | result="failure" [5m]
))
/
sum by (operation) (count_over_time(
  {app="eduvault"} | json | eduvault_telemetry="true" [5m]
))
```

**Purchase conversion funnel**

```logql
sum(count_over_time({app="eduvault"} | json | metric="conversion.checkout_initiate" [1h]))
vs
sum(count_over_time({app="eduvault"} | json | metric="conversion.purchase" [1h]))
```

**Slow requests (over 2s)**

```logql
{app="eduvault"} | json | eduvault_telemetry="true" | latencyMs > 2000
```

If your backend ingests metrics rather than logs, map:

- `eduvault_telemetry_seconds` (histogram) labeled by `operation`, `actorType`, `result`
- `eduvault_telemetry_total` (counter) labeled by `operation`, `actorType`, `result`
- `eduvault_conversion_total` (counter) labeled by `metric`

## Redaction policy

`redactSensitive()` runs on **every** record before it leaves the process.

1. **Sensitive keys are masked** (`[REDACTED]`), matched case-insensitively:
   `password`, `passphrase`, `secret`, `token`, `jwt`, `authorization`,
   `bearer`, `cookie`, `session`, `apiKey`/`api_key`, `privateKey`,
   `private_key`, `seed`, `mnemonic`, `recoveryPhrase`, `signature`,
   `signedXdr`, `signed_xdr`, `xdr`, `email`, `ssn`, `cardNumber`, `cvv`, `cvc`.
2. **Sensitive value shapes are masked anywhere**, including inside free text:
   Stellar secret seeds (`S…`, 56 chars), JWTs, `Bearer …` credentials,
   email addresses, and full 64-char hex digests.
3. **Raw request bodies are never logged.** Callers pass only the specific,
   non-sensitive `metadata` fields they want recorded.
4. Nested objects are walked up to 6 levels, arrays are mapped element-wise,
   and strings are truncated at 2048 chars.
5. `Error` objects are reduced to `{ name, code, message }` with the message
   passed through the same masking.

## Usage

```js
import {
  withTelemetry,
  withTelemetryRoute,
  recordMetric,
  ACTOR_TYPES,
  TELEMETRY_RESULT,
} from "@/lib/monitoring/telemetry";

// Wrap any async operation.
await withTelemetry("wallet.fetch_balances", ACTOR_TYPES.USER, async () => {
  return horizon.loadAccount(address);
}, { metadata: { network: "testnet" } });

// Wrap a Next.js route handler; non-2xx/3xx responses are failures.
export const POST = withTelemetryRoute("purchase.complete", ACTOR_TYPES.USER, handlePost);

// Emit a standalone conversion metric.
recordMetric(
  "conversion.purchase",
  { materialId },
  { operation: "purchase.complete", actorType: ACTOR_TYPES.USER, result: TELEMETRY_RESULT.SUCCESS }
);
```

### Correlation ids

`withTelemetryRoute` reads `x-correlation-id`, `x-request-id`, or `traceparent`
from the incoming request. If none is present (or for non-HTTP operations) a
UUID is generated. Use `runWithCorrelationId(id, fn)` to propagate an id across
nested operations, and `getCorrelationId()` to read the current one.

## Adding a new operation

1. Add an entry to `CORE_OPERATIONS` in `src/lib/monitoring/telemetry.js`.
2. Wrap the call site with `withTelemetry`/`withTelemetryRoute`.
3. Use an allow-listed `metadata` object (never the raw request/DB document).
4. Run `npx vitest run src/lib/monitoring` — the coverage test fails if fewer
   than five operations are declared or any record is missing a field.
