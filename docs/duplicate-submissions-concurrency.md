# Duplicate Submissions Concurrency Tests (#1078)

`test/concurrency/duplicateSubmissions.test.js` exercises duplicate submission handling under deterministic multi-actor interleavings using `test/concurrency/harness.js` and `src/lib/backend/idempotency.js`.

## Covered Paths

- **Normal**: Concurrent duplicate submissions with the same `idempotencyKey` execute the insert once and return the single canonical submission ID (with `CONFLICT_IN_PROGRESS` for overlapping in-flight callers, then `replayed: true` after completion).
- **Content-Hash Dedup**: Concurrent submissions of identical `contentHash` under distinct idempotency keys converge on a single canonical record via unique-index conflict fallback.
- **Failure & Retry Storm**: A transient failure rolls back the partial `submissions` insert before `withIdempotency` marks failure; a retry storm converges on exactly one committed submission.
- **Authorization Race**: An unauthorized actor racing the legitimate creator fails closed (`AUTH_FORBIDDEN`, HTTP 403) before acquiring an idempotency claim, never poisoning the key.
- **Recovery**: An expired/abandoned `in_progress` claim is taken over cleanly by a single contender.
