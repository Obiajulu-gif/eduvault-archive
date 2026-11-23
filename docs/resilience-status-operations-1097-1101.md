# Resilience, status, and operator tooling (#1097–#1101)

This document describes the focused vertical slices delivered for:

- **#1097** — Stale-cache detection with repair recommendations
- **#1098** — End-to-end failure injection for critical workflows
- **#1099** — User-facing status for degraded dependencies
- **#1101** — Operator dashboard for unresolved partial failures

All four slices are additive: no existing export, endpoint, or response contract
was changed, and no new dependency was installed.

---

## #1097 — Stale-cache detection with repair recommendations

### Files

| Path | Purpose |
| --- | --- |
| `src/lib/cache/staleCacheDetector.js` | Detection, recommendations, repair executor, monitoring registry |
| `src/app/api/admin/cache/stale/route.js` | `GET` report / `POST` preview-or-repair |
| `tests/backend/stale-cache-detection.test.mjs` | Normal, stale, retry, authorization, registry tests |

### Behaviour

1. `detectStaleCache()` consumes `createBoundedCache().snapshot()` output (or an
   explicit array). It is strictly read-only.
2. Each finding has a stable reason (`EXPIRED`, `EXPIRED_PAST_GRACE`,
   `VERSION_BEHIND`, `UNVERIFIED`, `MISSING_VALUE`), severity, and a repair
   recommendation with ordered steps and a rollback description.
3. `buildStaleCacheReport()` produces a SHA-256 fingerprint so a repair can be
   rejected if findings drifted between inspection and confirmation.
4. `createStaleCacheRepairer().apply()` **defaults to `dryRun: true`**. A real
   repair requires `dryRun: false`, an authorized principal, and a registered
   cache. Transient failures retry with exponential back-off; errors marked
   `retryable === false` fail immediately.

### Edge cases and recovery

| Edge case | Handling |
| --- | --- |
| Expired but inside grace window | `EXPIRED` → `REFRESH`; value is still safe to serve briefly. |
| Expired beyond grace | `EXPIRED_PAST_GRACE` → `PURGE_AND_REFILL`; critical severity. |
| Source version drift | `INVALIDATE_AND_REFILL`; a refill whose version still differs is rejected. |
| Missing cached value | `REBUILD_FROM_SOURCE`; highest-priority actionable finding. |
| Verification overdue | `UNVERIFIED` → `VERIFY_SOURCE`; no data written on success. |
| Repair handler unavailable | Non-retryable `StaleCacheRepairError` (502) with key/scope/attempts. |
| Rollback | There is no "restore stale value" write. Recovery is to leave the key invalidated so reads fall through to the authoritative source. This is always safe. |

### Migration / compatibility

`registerCacheForMonitoring(name, cache)` is opt-in; caches that do not register
remain invisible to the endpoint. Existing cache methods and counters are
untouched. The endpoint returns an empty report until a cache registers.

---

## #1098 — End-to-end failure injection for critical workflows

### Files

| Path | Purpose |
| --- | --- |
| `src/lib/resilience/failureInjection.js` | Runner, fault registry, safety guards, simulated workflows |
| `src/app/api/admin/failure-injection/route.js` | `GET` catalog / `POST` drill |
| `tests/backend/failure-injection-e2e.test.mjs` | Normal, failure, retry, auth, rollback, opt-in tests |

### Behaviour

A workflow is an ordered list of steps, each with `execute(ctx)` and
`compensate(ctx, result)`. The runner injects one fault at one dependency
boundary and returns a full trace: per-step attempts, recorded effects,
compensation results, retry count, and final status.

Supported faults: `DEPENDENCY_TIMEOUT`, `DEPENDENCY_ERROR`, `PARTIAL_WRITE`,
`AUTH_DENIED`, `RATE_LIMIT`, `CACHE_UNAVAILABLE`.

### Safety model

- Workflow ids are allow-listed (`purchase`, `entitlement_grant`,
  `material_upload`, `payout`, `notification`).
- `authorize(principal, …)` runs before planning or execution. Failures and
  thrown auth hooks are denials.
- `dryRun: true` is the default and executes no step.
- Real execution requires `FAILURE_INJECTION_ENABLED=true` **and** a
  constant-time match against `FAILURE_INJECTION_TOKEN`. Production is blocked
  unless `allowInProduction` is explicitly set by an authorized caller.
- The runner never flips environment variables, signs transactions, or writes
  to a database. Built-in workflows record effects in memory only; real
  services register their own steps with `registerWorkflow`.

### Edge cases and recovery

| Edge case | Handling |
| --- | --- |
| Transient fault | One-shot by default: retry reaches the next attempt and completes. `persistent: true` exhausts retries. |
| `PARTIAL_WRITE` | Side effect is recorded once, never replayed; compensations run in reverse order including that step. |
| `AUTH_DENIED` | Treated as permanent: no retry, immediate rollback of committed steps. |
| Compensation failure | Recorded as `compensation_failed` in the trace; the original failure is still reported. |
| Unknown workflow / step / fault | `FailureInjectionValidationError` (400). |
| Rollback | Every step must supply `compensate`; reverse-order compensation is the recovery path. A dry run changes nothing. |

### Migration / compatibility

New module and route only. No existing workflow, script, or environment
variable is required unless a real drill is executed.

---

## #1099 — User-facing status for degraded dependencies

### Files

| Path | Purpose |
| --- | --- |
| `src/lib/status/degradedDependencyStatus.js` | Public status model, leak checks, override store |
| `src/app/api/status/dependencies/route.js` | Public feature-impact status |
| `src/app/api/admin/status/dependencies/route.js` | Operator view and overrides |
| `tests/backend/degraded-dependency-status.test.mjs` | Normal, failure, retry, auth, zero-leak tests |

### Behaviour

`checkAllDependencies()` output is translated into feature-level impact only.
Internal dependency names, hostnames, latencies, remediation text, and raw
errors are dropped; all free-form text passes through the existing
`sanitizeText()` helper. Statuses are `operational`, `degraded`,
`partial_outage`, `unavailable`, and `maintenance`.

- Critical dependency failure → `unavailable`; non-critical → `partial_outage`.
- Subsystem maintenance overrides the aggregate to `maintenance`.
- `retryAfterSeconds` is the longest retry window among affected features.
- `assertSafeForUsers(payload)` fails closed if diagnostics leaked.

### Edge cases and recovery

| Edge case | Handling |
| --- | --- |
| Health provider throws | Store serves a safe `degraded` payload with no error text. |
| Misconfigured dependency | Reported as an outage without remediation details. |
| Operator override | Requires `status:override` authorization; may only **escalate** severity, never mask an outage as healthy. |
| Stale override | In-memory only; cleared on `DELETE` or process restart, which falls back to live checks. |
| Rollback | `DELETE /api/admin/status/dependencies` with `{ dependency }` clears an override and re-derives status. |

### Migration / compatibility

`GET /api/status` keeps its exact response shape and status codes. The new
endpoint is additive and independently cacheable.

---

## #1101 — Operator dashboard for unresolved partial failures

### Files

| Path | Purpose |
| --- | --- |
| `src/lib/operations/partialFailureDashboard.js` | Triage view model and gated action executor |
| `src/app/api/admin/partial-failures/triage/route.js` | `GET` triage / `POST` action |
| `src/app/admin/partial-failures/page.js` | Triage panel added to the existing dashboard |
| `tests/backend/partial-failure-dashboard.test.mjs` | Normal, failure, retry, auth, audit tests |

### Behaviour

`buildUnresolvedDashboard()` consumes `getPartialFailures()` output and adds:

- unresolved/retrying-only filtering,
- age buckets and severity-based SLA targets,
- grouped queues by domain, severity, and age bucket,
- a recommended next action with rollback guidance for every item,
- a fingerprint for drift detection.

The existing dashboard page renders a triage queue (SLA breaches, user-action
count, safe-to-retry count, oldest age, next action) alongside its current
failure table. Existing filters, inspect modal, retry, and resolve flows are
unchanged.

### Edge cases and recovery

| Edge case | Handling |
| --- | --- |
| Failure needs user action | Escalation recommended; automatic retry is blocked by the executor. |
| Failure not safely retryable / retry budget exhausted | Manual verify-and-resolve recommended; retry blocked. |
| SLA breach | Escalation recommended; no state is mutated. |
| Handler transient failure | Retried with exponential back-off; permanent errors surface as `DashboardActionError` (502). |
| Audit | Every preview and applied action is recorded with actor, reason, and an idempotency key. |
| Rollback | Retry is idempotent — failure remains unresolved on failure. `ACKNOWLEDGE`/`ESCALATE` are audit-only. Resolving manually can be reversed by the existing partial-failure tooling. |

### Migration / compatibility

No database schema change. The new route reuses `getPartialFailures`,
`retryPartialFailure`, `resolvePartialFailure`, and the signed audit ledger.
The original `/api/admin/partial-failures` GET/PATCH and `/retry` endpoints
remain unchanged.

---

## Acceptance criteria checklist

- [x] Normal, failure, retry, and authorization paths implemented and covered by automated tests for all four issues.
- [x] Edge cases and recovery/rollback behaviour documented above and in module headers.
- [x] Existing contracts preserved; all additions are new exports/endpoints/UI panels.
- [x] No dependencies installed; verification uses the repository's existing `node:test` harness.
