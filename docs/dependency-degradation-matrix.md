# Dependency degradation matrix and fallback behavior (#1081)

`src/lib/health/dependencyChecker.js` (#843) reports the state of each dependency. `src/lib/degradationMatrix.js` (#956) declares what each operation does when a service is degraded or unavailable. `src/lib/degradation/dependencyFallbackPlanner.js` connects the two, so a real health report becomes a decision for every operation.

```bash
npm run health:matrix                                   # live checks
npm run health:check -- --json > report.json
npm run health:matrix -- --from report.json --json      # from a saved report
```

Exit code 0 means every operation is allowed, 2 means at least one is degraded, queued, or blocked, and 1 means the tool itself failed. Tests: `tests/backend/dependency-fallback-planner.test.mjs`.

## Matrix

Health checks feed matrix services as follows. When two checks feed one service, the worse state wins.

| Health check | Matrix service | Tier |
| --- | --- | --- |
| `database` | `mongodb` | 1, critical |
| `stellar`, `contracts` | `stellar` | 1, critical |
| `storage` | `pinata` | 2, essential |
| `email` | `email` | 3, supporting |
| (none) | `webhooks` | 3; reported as `observed: false` and assumed healthy, since it has its own circuit breaker |

Health status maps to matrix state:

| Health status | Matrix state | Retryable |
| --- | --- | --- |
| `healthy` | healthy | no (nothing to retry) |
| `degraded` | degraded | yes, after `retryAfterSeconds` |
| `unavailable` | unavailable | yes, after `retryAfterSeconds` |
| `misconfigured` | unavailable (fail closed) | **no**, because waiting does not fix config |
| anything else | unavailable (fail closed) | yes |

The action per operation (`allow`, `degrade`, `queue`, `block`), the HTTP status, and the user message come from `DEGRADATION_MATRIX`, which is unchanged. For example, with MongoDB unavailable, `write_purchase`, `write_intent` and `settle_refund` are blocked (503) and `read_catalog` degrades to cached data.

## Fallback execution (retry path)

`runWithFallback(decision, handler)`:

- `block`: the handler is never called, and the matrix's user-safe 503 body is returned.
- `queue`: `onQueue` is called, and a queued body is returned.
- `allow` / `degrade`: the handler runs. Failures are retried with exponential backoff only when the decision is retryable, then the user-safe degraded body is returned. Raw errors (connection strings, hosts) never reach the response.

## Operator overrides (authorization path)

`applyOperatorOverride(decision, { actor, override })` lets an operator change one decision temporarily.

- Only admins (`operations:override`, which only the admin wildcard grants) may override.
- `override.reason` (at least 10 characters) and `override.expiresAt` (in the future, at most 4 hours away) are required. Expired overrides are ignored, so the matrix takes over again without anyone acting.
- **Tightening** to `block` is always allowed. It works as a kill switch, for example during a double-charge incident.
- **Relaxing** is refused for critical operations the matrix blocks, and for any tier 1 service that is unavailable. Money-moving paths therefore cannot be forced open.
- Every applied override returns an `audit` object (actor, from, to, reason, expiry). Write it to the audit ledger.

## Recovery

Decisions are computed from the report passed in. When the next health report is healthy, every operation returns to `allow` automatically. Nothing needs resetting, and the process-wide fallback registry is not modified.

## Compatibility

No existing exports change. `degradationMatrix.js`, `fallback.js`, and `dependencyChecker.js` keep their behavior. The planner is additive and can be adopted per route by replacing `executeWithDegradation` with `decideOperation` plus `runWithFallback`.
