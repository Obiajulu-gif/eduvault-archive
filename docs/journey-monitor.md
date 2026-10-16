# Synthetic Journey Monitor

`src/lib/monitoring/journeyMonitor.js` + `scripts/journey-monitor.mjs`

## What it is

A synthetic end-to-end health check for EduVault's most valuable workflow:

```
checkout quote → purchase confirm → entitlement grant → authorized access → download capability
```

The monitor replaces the placeholder steps 3–6 in `scripts/smoke-test.sh`. It
runs the **real** modules (`createCheckoutQuote`, `consumeCheckoutQuote`,
`createEntitlement`, `getMaterialAccessStatus`, capability tokens) against a
synthetic material and synthetic buyer, cleans up after itself, and reports:

- **Per-step latency** — min/avg/p50/p95/max per step and overall.
- **Failures** — step id, error code/message, and the step that stopped the run
  (later steps are marked `skipped`).
- **Dependency blame** — the subsystem an operator should check first
  (`mongodb`, `checkout-quotes`, `entitlement-policy`, `download-capability`,
  `stellar-rpc`, `ipfs-gateway`, `outbox`). Blame uses an explicit
  `error.dependency`, then known error-text patterns, then the step's declared
  dependency.

The report contract is stable (`runId`, `ok`, `steps[]`, `failures[]`, `blame`)
and is consumed by the CLI, the webhook, and alerting.

## Running it

```bash
# CI-safe wiring check — no database, deterministic latencies:
npm run monitor:journey:dry

# Full live run against a database:
MONGODB_URI="$URI" npm run monitor:journey

# Scheduled, multiple samples:
MONGODB_URI="$URI" node scripts/journey-monitor.mjs --runs=3

# Exercise the failure path deterministically (always exits non-zero):
node scripts/journey-monitor.mjs --dry-run --inject-failure=checkout_quote
```

| Option / env | Default | Meaning |
| --- | --- | --- |
| `--runs=N` / `JOURNEY_MONITOR_RUNS` | 1 | Number of journey samples |
| `--max-failures=N` / `JOURNEY_MONITOR_MAX_FAILURES` | 0 | Allowed failed runs before exit 1 |
| `--step-timeout-ms=N` / `JOURNEY_MONITOR_STEP_TIMEOUT_MS` | 15000 | Per-step timeout |
| `--inject-failure=<stepId>` | — | Dry-run only: force a failure at that step |
| `JOURNEY_MONITOR_WEBHOOK_URL` | — | Optional JSON webhook for the summary |
| `MONGODB_URI`, `MONGODB_DB` | —, `eduvault` | Live connection settings |

Exit codes: `0` pass, `1` failure/crash. Schedule via GitHub Actions
(`.github/workflows/journey-monitor.yml`) or cron:

```cron
*/15 * * * * cd /srv/eduvault && MONGODB_URI="$MONGODB_URI" node scripts/journey-monitor.mjs --runs=2 >> /var/log/eduvault-journey.log 2>&1
```

## Operational edge cases

| Case | Behaviour | Operator note |
| --- | --- | --- |
| Live run, no `MONGODB_URI` | Exits 1 immediately | Monitoring misconfiguration, not an outage |
| Synthetic rows left behind | Re-run upserts over them; `finally` cleanup deletes quotes/purchases/entitlements/material | Search for `syntheticMonitor: true` and `buyerAddress: "journey-monitor-buyer"` |
| Overlapping runs | Synthetic buyer is shared; quote consumption is per-quote, purchases are upserted | Safe by design; stagger schedules if you want clean latency numbers |
| Gateway/CDN outage | Download step verifies capability issuance/signature only — it does **not** fetch bytes | Gateway health is out of scope; blame for this step means capability signing |
| Chain/RPC outage (live) | The authorize step is cache-backed when the synthetic purchase + entitlement are consistent; an RPC fallback failure blames `entitlement-policy`/`stellar-rpc` | Inspect `blame.dependency` first |
| Slow environment | Raise `--step-timeout-ms`; timeouts are reported as `journey_step_timeout` | A timeout in one step stops the run |

## Failure modes and diagnosis

1. **Read the blame**: `summary.blame[0].dependency` names the subsystem with
   the most failed runs.
2. **Per-step latency regressions**: compare `latency.steps.<id>.latencyMs.p95`
   across runs; step order makes the degrading layer obvious.
3. **`harness_step_missing`**: code/config drift — the monitor definition and
   the harness have diverged. Fix in `JOURNEY_DEFINITION` + `buildLiveHarness`.
4. **Webhook failures**: reported non-fatally; monitoring alerting itself
   should not be able to fail the health check.

## Rollback / recovery

- The monitor never mutates production user data: all rows use a reserved
  material id (`journey-monitor-material`), buyer (`journey-monitor-buyer`),
  and creator, and are deleted after each run.
- To disable: remove the workflow/cron entry; no runtime code changes required.
- If cleanup is suspected to have failed, run
  `mongosh "$MONGODB_URI" --eval 'db.purchases.deleteMany({buyerAddress:"journey-monitor-buyer"}); db.entitlement_cache.deleteMany({buyerAddress:"journey-monitor-buyer"}); db.checkout_quotes.deleteMany({buyerAddress:"journey-monitor-buyer"}); db.materials.deleteMany({syntheticMonitor:true})'`
  and then run the monitor once more in dry mode to confirm wiring.

## Tests

`tests/backend/journeyMonitor.test.mjs` — step order, latency capture, detail
propagation, first-failure skip semantics, dependency classification
(mongo/capability/explicit), timeout handling, missing-harness-step, summary
aggregation and percentiles.

Run: `npx tsx --test tests/backend/journeyMonitor.test.mjs`
