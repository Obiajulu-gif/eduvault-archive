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

## High-cardinality protection

Redaction (above) keeps secrets out of telemetry. The guard in
[`src/lib/monitoring/telemetryGuard.js`](../src/lib/monitoring/telemetryGuard.js)
keeps *attacker-controlled volume and variety* from wrecking the log/metric
backend and the dashboards built on it. It runs inside `emitRecord()` for every
`withTelemetry`, `withTelemetryRoute` and `recordMetric` call.

### What is enforced

| Layer | Rule | Result |
| --- | --- | --- |
| Label values | `operation`, `actorType`, `result`, `metric`, `metricType`, `errorCode` must be ≤64 chars of `[A-Za-z0-9_.:-]` and must not look like an identifier (UUID, ObjectId/hex digest ≥16, Stellar strkey, ≥9-digit number, opaque 32+ char token) | Offending value replaced by `__invalid__`; rejection counted by reason |
| Label keys | `validateLabels()` only accepts `ALLOWED_LABEL_KEYS`; per-entity keys (`userId`, `walletAddress`, `txHash`, `email`, `url`, …) are rejected | Dropped with a reason (`high_cardinality_key`, `key_not_allowed`) |
| Series cardinality | At most 500 distinct `operation|actorType|result|metric` series and 100 distinct `errorCode`s per idle window (10 min) | Excess folds into `__overflow__` series / `errorCode=__overflow__`; still counted |
| Sampling | Per-series token bucket (success 100 burst / 50 per s, failure 300 burst / 150 per s) plus a global bucket (2000 burst / 1000 per s) with 20% reserved for failures | Excess records are not emitted but are tallied |
| Field bounds | `metadata`/`error` and API-logger context: ≤40 keys, ≤50 array items, depth ≤5, keys `[A-Za-z0-9_.$-]{1,64}`, control characters → space, `__proto__`/`constructor`/`prototype` dropped | Excess dropped and counted in `fieldsDropped` |
| Redaction | Unchanged `redactSensitive()`, applied after bounding (so a secret is never truncated into an unmatchable fragment) | `[REDACTED]` |

Sampling is deterministic (token bucket, no random draw), so the same input at
the same timestamps always produces the same output.

### Keeping dashboards correct under sampling

Sampled-out records are never silently lost:

- The next kept record for that series carries
  `suppressed: { count, value }` — the number (and summed `value` for
  counters) of records dropped since the previous kept one.
- `flushTelemetrySummaries()` (also called opportunistically every 30 s) emits a
  `telemetry.suppressed` metric per series with the pending tally.
- `getTelemetryGuardStats()` returns exact, unsampled counters per series
  (`total`, `failures`), plus `sampledOut`, `overflowed`, `labelRejections`,
  `fieldsDropped`, and `lostSuppressed`.

True volume for a series = kept records + `suppressed.count` (+ any pending
summary). Rate panels should sum `1 + suppressed.count` per kept record.
Latency percentiles are computed over kept records only; because failures have
their own larger budget, error rate and error latency stay representative even
when successes are heavily sampled.

Alert on these signals — they mean someone is probing or a caller is building
labels from input:

- `labelRejections` growing, or many records with `operation="__invalid__"`
- `overflowed` > 0 or any `__overflow__` series
- `sampledOut` sustained > 0 outside a known incident
- `fieldsDropped.keys` growing (request-derived objects reaching log context)

### Rules for call sites

1. Put only bounded categories in `operation`/`metric`/`errorCode`. Never
   interpolate ids, paths, emails or error messages into them.
2. Per-entity context (order id, material id) belongs in `metadata`, which is
   bounded and redacted but is not an indexed dimension.
3. Configure your log pipeline to index only the dimension fields above; do not
   promote `metadata.*` keys to labels.
4. Use `sanitizeLogFields(obj)` for any ad-hoc log line containing
   request-derived data (the API request logger already does).

### Edge cases and failure modes

- **Legitimate new operation name rejected.** Names must be lower-case dotted
  words, e.g. `payout.release`. A name with `/`, spaces or an id is collapsed to
  `__invalid__`; check `labelRejections` and fix the call site.
- **Operation names that look like identifiers.** A name made of 16+ hex chars
  or a 9+ digit run is treated as an identifier and rejected.
- **Series table full of stale series.** Idle series (>10 min) are evicted when
  the table is full; any unreported suppression on an evicted series is counted
  in `lostSuppressed` (the 30 s summary flush makes this rare).
- **Overflow series.** Overflow series are force-admitted (a fixed handful of
  keys) so excess volume is still counted rather than dropped.
- **Per-process state.** Buckets and counters are per Node process/instance.
  Fleet-wide volume is the sum across instances; the global budget is
  per-instance.
- **Failure storms.** Failures are sampled too (otherwise a failing dependency
  could flood the backend), but with a 3× burst and a reserved global slice.
  Their tally is preserved, so failure *rate* stays exact.
- **Broken sink.** A throwing sink is caught and never fails the operation.
- **Clock jumps backwards.** Elapsed time is clamped at 0, so buckets just stop
  refilling until the clock catches up.
- **Memory.** State is bounded: ≤500 (+ a few overflow) series and ≤100 error
  codes, each a few numbers.

### Rollback and recovery

- **Disable the guard at runtime:** set `TELEMETRY_GUARD=off` (read on every
  emission, restart not needed where env can be changed live; otherwise
  redeploy). Records then flow unsampled and unvalidated exactly as before this
  change. **Redaction stays on** — it is independent of the guard.
- **Retune instead of disabling:** call `resetTelemetryGuard({ config })` with
  larger buckets or `maxSeries` if legitimate traffic is being sampled.
  `createTelemetryGuard` options are the only tuning surface.
- **Recover counts after an incident:** `getTelemetryGuardStats()` and the
  `telemetry.suppressed` summaries contain the exact totals; reconstruct
  dashboards from `kept + suppressed.count`.
- **Clear state:** `resetTelemetryGuard()` drops all series, buckets and
  counters; sampling resumes from full buckets.

### Verification

```bash
npx vitest run src/lib/monitoring
```

`telemetryGuard.test.js` covers label validation, series/error-code caps,
deterministic sampling, count preservation, failure priority, recovery after
abuse, field bounding, prototype-pollution keys, redaction ordering, the
summary flush, and the rollback switch.
