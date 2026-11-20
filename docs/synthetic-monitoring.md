# Synthetic Monitoring for Critical End-to-End Journeys

**Issue #1014** — `src/lib/monitoring/syntheticMonitor.js` + `scripts/synthetic-monitor.mjs`

## Overview

The synthetic monitoring layer extends the existing journey monitor with
**multi-scenario coverage**, **SLA thresholds**, **structured health
reporting**, and a **scheduler** that maintains a rolling window of run history
and fires alerts when thresholds are breached.

---

## Journey Scenarios

| Scenario ID                  | Name                            | p95 SLA  | Description |
|------------------------------|---------------------------------|----------|-------------|
| `buyer_purchase_flow`        | Buyer purchase flow             | 5 000 ms | Canonical quote → purchase → entitlement → capability path |
| `creator_publish_to_access`  | Creator publish → buyer access  | 8 000 ms | Creator publishes material; buyer gains entitlement |
| `auth_challenge_verify`      | Auth challenge → verify → session | 2 000 ms | Wallet challenge + session creation |
| `search_to_purchase`         | Search → material detail → purchase | 3 000 ms | Search index → checkout quote |
| `entitlement_revocation`     | Entitlement revocation          | 3 000 ms | Active entitlement revoked; access correctly denied |

All scenarios share a **95 % success-rate floor** over a rolling window of the
last 10 runs.

---

## Health States

| State      | Meaning |
|------------|---------|
| `green`    | All SLAs met across all scenarios |
| `degraded` | One or more scenarios are within 50 % of an SLA breach (warning) |
| `red`      | One or more scenarios have breached their SLA |

The overall `health` field in a report is the worst individual scenario health
(red > degraded > green).

---

## Running the Monitor

```bash
# CI wiring check — no database required:
npm run monitor:synthetic:dry

# Live run against a database (all scenarios):
MONGODB_URI="$URI" npm run monitor:synthetic

# Specific scenarios only:
node scripts/synthetic-monitor.mjs --dry-run --scenarios=buyer_purchase_flow,auth_challenge_verify

# Inject a failure for testing alerting (dry-run only):
node scripts/synthetic-monitor.mjs --dry-run --inject-failure=buyer_purchase_flow

# Output full JSON report:
node scripts/synthetic-monitor.mjs --dry-run --json
```

### Environment Variables

| Variable                           | Default   | Description |
|------------------------------------|-----------|-------------|
| `MONGODB_URI`                      | —         | Required for live runs |
| `MONGODB_DB`                       | `eduvault`| Database name |
| `SYNTHETIC_MONITOR_WEBHOOK_URL`    | —         | JSON webhook endpoint for results |
| `SYNTHETIC_MONITOR_STEP_TIMEOUT_MS`| `15000`   | Per-step timeout |

**Exit codes:** `0` = green or degraded, `1` = red health or crash.

---

## Internal API

`GET /api/internal/synthetic-health`

Protected by admin/service token. Runs a dry-run health check on demand.

**Query params:**

| Param        | Description |
|--------------|-------------|
| `?dry=1`     | Force dry-run (default — live adapters not injected via HTTP) |
| `?scenarios=id1,id2` | Restrict to a subset of scenario ids |

**Response:**
```json
{
  "health": "green",
  "checkedAt": "2026-10-17T12:00:00.000Z",
  "checkId": "...",
  "summary": { "totalScenarios": 5, "passing": 5, "degraded": 0, "failing": 0 },
  "scenarios": [
    {
      "id": "buyer_purchase_flow",
      "name": "Buyer purchase flow",
      "health": "green",
      "sla": { "successRateFloor": 0.95, "p95LatencyMs": 5000, ... },
      "lastRun": { "ok": true, "durationMs": 320, "failures": [], "blame": { "primary": null } },
      "history": { "runs": 1, "successRate": 1, "latency": { "p50": 320, "p95": 320 } }
    }
  ]
}
```

---

## Scheduler (Programmatic Use)

```js
import { createSyntheticMonitorScheduler, HEALTH_STATES } from "@/lib/monitoring/syntheticMonitor";

const scheduler = createSyntheticMonitorScheduler({
  intervalMs: 5 * 60_000, // every 5 minutes
  adapters:   myAdapters,
  onCheck: (report) => {
    console.log("Health:", report.health);
  },
  onAlert: ({ scenarioId, breach, checkedAt }) => {
    console.error(`ALERT: ${scenarioId} breached SLA — ${breach.message}`);
    // page on-call, post to Slack, etc.
  },
});

scheduler.start();
// later:
scheduler.stop();
```

---

## GitHub Actions

`.github/workflows/synthetic-monitor.yml` runs on the same 15-minute schedule
as the journey monitor workflow.  The dry-run step always executes; the live
step runs only when `MONGODB_URI` is configured.

---

## Tests

`tests/backend/syntheticMonitor.test.mjs`

```bash
npx tsx --test tests/backend/syntheticMonitor.test.mjs
```

Covers: scenario definitions shape, SLA evaluation (green/degraded/red),
individual scenario runner, full health check roll-up, onScenario/onAlert
callbacks, scheduler tick/stop, and rolling history window enforcement.


---

## Execution Paths (#1148)

### 1. Normal Path
- The runner executes all configured scenario pipelines sequentially or on a timed interval.
- Each scenario runs its multi-step pipeline (e.g. quote -> purchase -> entitlement -> download capability).
- Step latencies are captured and pushed to a bounded rolling window.
- Overall health rolls up to `green` when all scenario SLAs (p95 latency and >=95% success floor) are satisfied.

### 2. Failure Path
- If a step throws or times out (exceeding `stepTimeoutMs`), the scenario fails immediately.
- Blame attribution maps the failed step to its upstream subsystem (e.g. `checkout-quotes`, `storage-ipfs`, `stellar-rpc`).
- The health state transitions to `red`, alerting hooks (`onAlert`) are triggered, and the process exits with code `1`.

### 3. Retry Path
- When transient network flakiness occurs during step execution, the monitor supports step-level retries (`maxRetries > 0`) with backoff.
- If a subsequent retry passes within SLA bounds, the step is recorded as recovered.
- If retries are exhausted, the failure is recorded and blames are rolled up.

### 4. Authorization Path
- Programmatic execution via `runHealthCheck({ actor })` or API calls to `/api/internal/synthetic-health` require authorized identities.
- `assertSyntheticMonitorAuthorized(actor)` enforces that only actors with roles `admin`, `operator`, or `service` may trigger health evaluations.
- Unauthorized callers receive `SyntheticAuthorizationError` (HTTP 403).

---

## Edge Cases, Recovery & Rollback

- **Zero-Dependency CI Verification:** Running with `--dry-run` uses synthetic step stubs and requires no external MongoDB database or network connectivity.
- **Rolling Window Bounded Memory:** History is maintained in an in-memory ring buffer strictly capped at `windowSize` (default: 10 runs), preventing memory leaks in daemon mode.
- **Synthetic Row Isolation:** In live database mode, all synthetic test materials use unique prefixed IDs (`synthetic_`) and are cleaned up via `cleanupSyntheticRows(db)` in a `finally` block, guaranteeing test data never pollutes production catalogs.
- **Rollback Behavior:** Synthetic monitors are read-only observers. To roll back an automated schedule, call `scheduler.stop()` or disable the GitHub Actions cron job.
