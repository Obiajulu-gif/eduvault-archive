# Duplicate Submissions Concurrency Tests (#1078)

`test/concurrency/duplicateSubmissions.test.js` exercises duplicate submission handling under deterministic multi-actor interleavings using `test/concurrency/harness.js` and `src/lib/backend/idempotency.js`.

## Covered Paths

- **Normal**: Concurrent duplicate submissions with the same `idempotencyKey` execute the insert once and return the single canonical submission ID (with `CONFLICT_IN_PROGRESS` for overlapping in-flight callers, then `replayed: true` after completion).
- **Content-Hash Dedup**: Concurrent submissions of identical `contentHash` under distinct idempotency keys converge on a single canonical record via unique-index conflict fallback.
- **Failure & Retry Storm**: A transient failure rolls back the partial `submissions` insert before `withIdempotency` marks failure; a retry storm converges on exactly one committed submission.
- **Authorization Race**: An unauthorized actor racing the legitimate creator fails closed (`AUTH_FORBIDDEN`, HTTP 403) before acquiring an idempotency claim, never poisoning the key.
- **Recovery**: An expired/abandoned `in_progress` claim is taken over cleanly by a single contender.

## POST /api/collections against a real unique index (#1150)

`test/concurrency/collectionsDuplicateSubmissions.test.js` drives the real route handler
(`src/app/api/collections/route.js`) against the in-memory MongoDB that `test/global-setup-outbox.js`
starts. The suites above use a fake collection. This one needs real index semantics, because the
deduplication guarantee comes from MongoDB's unique index, not from application code. A find barrier
holds every concurrent request at the "already exists?" lookup until all of them have reached it. Every
run therefore exercises the insert race and the E11000 fallback, and none depends on timing luck.

```bash
npx vitest run test/concurrency/collectionsDuplicateSubmissions.test.js
```

| Path | Behaviour covered |
|------|-------------------|
| Normal | 8 concurrent creates with the same key (in the body or in `x-idempotency-key`) store one collection: one `201`, seven `200` with `duplicate: true`, and one id. |
| Keyless | Creates without a key are never deduplicated. |
| Failure + retry | An insert that fails (dropped connection) returns `500` and stores nothing. The retry with the same key returns `201` once, and later retries replay it with `200`. A non-string key (number, object) is rejected with `400` before any write. |
| Authorization | Missing, forged (wrong secret) and malformed session cookies return `401` before any write. A key is scoped to its creator: another creator using the same key gets their own collection and never sees the first one. |

### Defects fixed

- **The route could not load.** #906 changed the import to `jsonswebtoken` (typo), so every request to
  `/api/collections` failed and the module could not be resolved. It imports `jsonwebtoken` again.
- **A creator's second collection created without a key failed with 500.** The index was
  `{ creatorId, idempotencyKey }` `unique` + `sparse`. A sparse compound index still indexes every document
  that has at least one of its keys, and every document has `creatorId`. So two keyless documents
  (`idempotencyKey: null`) from one creator collided. The index now uses
  `partialFilterExpression: { idempotencyKey: { $type: "string" } }`. MongoDB applies the unique constraint
  only to documents that match the filter.

### Migration plan

The index has a new name, `collections_creator_idempotency_key`, and the route creates it on first use.
Reusing the old name with the new options fails with `IndexKeySpecsConflict` (86). An old index left in
place would keep blocking keyless creates. Before #906 there was no index, and after #906 the route could
not load, so the old `collections_creator_idempotency` index should not exist anywhere. Check, and drop it
if it does:

```js
db.collections.getIndexes()                              // look for collections_creator_idempotency
db.collections.dropIndex("collections_creator_idempotency")
```

Rollback: revert the route. The new index is harmless to the old code. Drop it only if you also restore the
sparse index.

### Edge cases

- **First request on an empty database.** Concurrent requests may each run `createIndex` and the
  collection's implicit creation. The first test runs before the collection exists (the suite drops its
  database when it finishes), so this race runs on every test run.
- **Keys are not trimmed or normalized.** `"k"` and `"k "` are different keys.
- **A duplicate is not compared with the first payload.** A replay returns the stored collection even if
  the retried body differs. That is the existing contract. Clients must send a new key for new content.
