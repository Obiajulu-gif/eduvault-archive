# Source-to-Cache State Reconciliation (#1073)

`src/lib/reconciliation/sourceCacheReconciler.js` reconciles authoritative source records against process-local or adapter-backed cached state (`createBoundedCache`).

## Guarantees & Contracts

- **Dry-run-first**: `dryRun` defaults to `true`. No cache mutations occur unless `dryRun: false` is explicitly passed.
- **Non-mutating inspection**: Uses `cache.snapshot({ scope })` so auditing does not alter LRU eviction order or hit/miss counters.
- **Authorization-gated**: `authorizeCacheReconciliation` requires `actor` to hold an authorized role (`admin`, `operator`, `system`) or pass a custom `authorize({ actor, scope })` check. Unauthorized calls fail closed with `AppError("FORBIDDEN")` before reading source records.
- **Scope isolation**: Detects `SCOPE_LEAK` if a non-public source record is present in `PUBLIC_SCOPE` and plans `INVALIDATE_CACHE`.
- **Preserves existing contracts**: `projectionReconciler.js` (MongoDB `purchases`/`materials` -> `entitlement_cache`/`search_index`) and all existing `createBoundedCache` methods remain unchanged; `snapshot()` is purely additive.

## Edge Cases & Recovery / Rollback

| Edge Case | Behavior | Recovery / Rollback |
| --- | --- | --- |
| Transient source read timeout | Retries `loadSourceRecords` up to `maxRetries` with linear backoff | Automatic retry; fails closed if exhausted |
| Transient cache write error | Retries per-item `cache.set`/`invalidate` up to `maxRetries` | Other healthy items still repair; failed items returned in `report.failedItems` |
| Oversized payload rejected by cache | `cache.set` returns `false`, recorded as per-item failure | Does not flush healthy entries; operator can inspect `failedItems` |
| Bad repair batch / post-repair anomaly | `report.rollbackSnapshot` captures pre-repair values and existence flags | Call `rollbackCacheRepairs(cache, report.rollbackSnapshot)` to restore prior values and invalidate newly added keys |
