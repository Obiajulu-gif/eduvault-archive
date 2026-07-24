# Observability: SLIs, SLOs, Alerts & Runbooks

Companion doc to issues #20 and #63. Defines what we measure, the targets we
hold ourselves to, and what to do when an alert fires.

## Correlation model

Every HTTP request entering the app (via `withApiHardening`, see
`src/lib/api/hardening.js`) gets a `correlationId` and a W3C `traceId`
(`src/lib/telemetry/context.js`). Both are:

- Returned to the caller in the `x-correlation-id` and `traceparent`
  response headers.
- Attached automatically to every structured log line for that request
  (`src/lib/logger.js` mixin).
- Stamped onto any workflow record created during that request
  (`workflowOrchestrator.createWorkflow`, stored at `metadata.telemetry`).

When the background worker (`src/lib/backend/workflowWorker.js`) later picks
up that workflow to reconcile a transaction, it **resumes the same trace**
instead of starting a new, disconnected one. This is what links:

into one traceable chain, without ever logging secrets, private keys, or
raw wallet credentials (see Redaction below).

## Redaction

`src/lib/telemetry/redact.js` strips `email`, `password`, `name`, `phone`,
`address`, `ip`, `token`, `authorization`, `cookie`, `secret`, `privateKey`,
and `jwt` fields before they reach any log, span, or metric label. Wallet
addresses are intentionally **not** redacted — they are pseudonymous
identifiers needed for debugging, not personal data.

## Sampling & retention

- **Sampling**: routine successful spans are sampled at
  `TELEMETRY_LOG_SAMPLE_RATE` (default: log all, 1.0). Error spans are
  **always** logged in full regardless of sample rate — we never want to
  sample away the one span that explains an incident. See
  `src/lib/telemetry/tracing.js`.
- **Retention**: this app does not persist logs itself (they go to stdout
  as structured JSON in production, per `src/lib/logger.js`). Retention is
  governed by whatever log pipeline/aggregator ingests stdout (e.g.
  CloudWatch, Datadog, Loki). Recommended baseline: 30 days hot, 90 days
  cold/archived, in line with typical incident-investigation windows.
  This should be configured at the log-shipping layer, not in-app.

## SLIs / SLOs

| SLI | Target (SLO) | Metric |
|---|---|---|
| Purchase success rate | ≥ 95% of purchases confirm successfully | `purchase_total{outcome}` |
| Purchase latency | p95 < 8s from checkout intent to confirmation | `purchase_latency_ms` |
| Indexer ledger lag | Indexer stays within 50 ledgers of chain tip | `indexer_ledger_lag` |
| Dead-letter backlog | Fewer than 25 unresolved dead-letter events | `indexer_dead_letter_count` |
| RPC error rate | Fewer than 10 RPC errors per observation window | `rpc_errors_total` |
| HTTP availability | Tracked per-route via `http_requests_total{outcome}` and `http_request_duration_ms` | — |

## Metrics reference

All metrics are exposed in Prometheus text format at `GET /api/metrics`
(`src/app/api/metrics/route.js`), backed by the in-memory registry in
`src/lib/telemetry/metrics.js`. Counters/histograms/gauges are capped at
200 label combinations per metric name to bound cardinality — samples
beyond the cap are dropped rather than growing memory unbounded.

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `http_requests_total` | counter | route, method, outcome | Request volume/errors per route |
| `http_request_duration_ms` | histogram | route, method | Latency per route |
| `purchase_total` | counter | outcome | Purchase success/failure count |
| `purchase_latency_ms` | histogram | — | Checkout-to-confirmation latency |
| `worker_jobs_total` | counter | type, outcome | Background worker throughput |
| `rpc_errors_total` | counter | operation | Stellar RPC failures |
| `indexer_events_applied_total` / `indexer_events_skipped_total` | counter | source | Indexer throughput |
| `indexer_ledger_lag` | gauge | source | How far the indexer is behind |
| `indexer_dead_letter_count` | gauge | source | Unresolved failed events |
| `stellar_sync_batches_total` | counter | source, outcome | Stellar sync batch outcomes |
| `stellar_sync_events_total` | counter | source, outcome | Stellar event apply outcomes |
| `dependency_up` | gauge | dependency | 1/0 per dependency from `/api/ready` |

## Alerts & runbooks

Alert rules live in `src/lib/telemetry/alerts.js` as pure functions over a
metrics snapshot, so they're testable locally against fixtures without a
live alerting backend (see `tests/backend/telemetry.test.mjs`).

### Purchase latency
**Rule**: `PurchaseLatencyHigh` — p95 purchase latency > 8s.
**Likely cause**: Stellar RPC slowness, indexer lag delaying reconciliation,
or worker polling interval too coarse.
**Runbook**: Check `/api/ready` for `stellar` status. Check
`indexer_ledger_lag`. If the indexer is behind, check for dead-letter
growth first (`reprocessDeadLetters` in `stellarIndexer.js`).

### Purchase success rate
**Rule**: `PurchaseSuccessRateLow` — success rate < 95% (min 5 samples).
**Likely cause**: Contract call failures, RPC errors, or a bug in
reconciliation logic.
**Runbook**: Query recent `purchase_total{outcome="failed"}` spans in logs
by `traceId` to find the common failure point. Check `rpc_errors_total`.

### Indexer lag
**Rule**: `IndexerLedgerLagHigh` — indexer more than 50 ledgers behind.
**Likely cause**: Indexer process down/crashed, RPC rate limiting, or a
poison event stuck retrying.
**Runbook**: Check indexer process is running. Check dead-letter backlog —
a single bad event can block a naive indexer; this one processes
per-event with independent dead-lettering so it shouldn't fully stall, but
verify via `indexer_events_applied_total` vs `indexer_events_skipped_total`.

### Dead-letter backlog
**Rule**: `DeadLetterBacklogGrowing` — more than 25 unresolved dead-letter
events.
**Runbook**: Run `reprocessDeadLetters()` manually. Inspect
`dead_letter_events` collection for `lastError` patterns — a shared error
message across many entries usually means a schema mismatch or bug, not
transient flakiness.

### RPC errors
**Rule**: `RpcErrorRateHigh` — more than 10 RPC errors in the window.
**Runbook**: Check Stellar RPC/Horizon status pages. Check `/api/ready`.
Consider whether `STELLAR_RPC_URL` needs to fail over to a backup provider.

## Dashboards

No live Grafana/dashboard infrastructure is deployed for this project yet.
The metrics above are exposed in standard Prometheus exposition format at
`/api/metrics`, so they are compatible with any standard dashboard tool
(Grafana, Datadog, Chronosphere, etc.) without further app changes —
point a scraper at that endpoint. Suggested first dashboard panels:
purchase success rate (last 1h/24h), purchase latency p50/p95/p99,
indexer ledger lag over time, dead-letter backlog over time, HTTP error
rate by route.

## Audit events

Issue #63 adds an allow-listed audit stream for API and operational actions.
Each JSON event has a timestamp and, when it runs in a request or worker, the
`correlationId` and `traceId`. Audit records intentionally contain only
operation metadata: no request body, file bytes, secrets, or credentials.

- Uploads record success, validation/storage failures, queued fallbacks, and
  quarantine decisions. Resumable uploads also record session creation,
  reads, part/complete/cancel updates, and conflicts.
- Stellar sync records batch completion, fetch failures, and each event that
  enters the dead-letter path. Search by `eventId` or `correlationId` to
  connect an operational record to its trace.

## Health vs readiness

- `GET /api/health` — liveness only. No dependency checks. "Is the process
  running?"
- `GET /api/ready` — readiness. Checks database + Stellar (critical —
  returns `503 unhealthy` if either is down) and Pinata + email
  (non-critical — returns `200 degraded` if either is down, since
  purchases/browsing still work without them).

## Known limitations / honest follow-ups

- `indexer_ledger_lag` measures true distance from the live chain tip. No extra
  RPC call is needed: the `getEvents` response already carries `latestLedger`
  (the tip as the RPC server sees it), which we now keep separate from the
  highest ledger we actually applied (`indexer_last_processed_ledger`). Lag is
  reported as 0 when a batch comes back short of `limit`, since a short page
  means the RPC handed us everything it had and a quiet chain should not alert.
  Both values are persisted on `sync_state` as `lastLedger` and
  `lastProcessedLedger`.
- Tracing runs in local-only mode (no real OTLP exporter wired) until
  `@opentelemetry/api` and an exporter package are installed and
  `OTEL_EXPORTER_OTLP_ENDPOINT` is configured — the code is written to pick
  this up transparently (see `src/lib/telemetry/tracing.js`) with zero call-site
  changes once that's done.
