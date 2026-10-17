# Concurrency Harness

A deterministic multi-actor harness for race-prone mutations: concurrent
actors, duplicate submissions, stale versions and retry storms around critical
writes.

- Harness: [`test/concurrency/harness.js`](../test/concurrency/harness.js)
- Scenarios: [`criticalWrites.test.js`](../test/concurrency/criticalWrites.test.js),
  [`lifecycleRaces.test.js`](../test/concurrency/lifecycleRaces.test.js),
  [`archiveSubmissions.test.js`](../test/concurrency/archiveSubmissions.test.js)
- Harness self-tests: [`harness.test.js`](../test/concurrency/harness.test.js)

Run: `npm run test:concurrency`

## How it works

Real races depend on timing, so they are flaky to test. The harness makes them
deterministic:

1. Every awaited database operation is a **scheduling point**
   (`instrumentDb`). The operation itself stays atomic, like a single-document
   MongoDB write.
2. A **seeded scheduler** picks which waiting actor resumes next.
3. `explore({ seeds: 40, scenario })` runs the scenario once per seed, giving 40
   different interleavings of the same actors. Invariants are asserted after
   every run, so they must hold for *all* of them.
4. The same seed always replays the same interleaving. A failure is reported as
   `[seed=N] <message>`; re-run just that seed with `explore({ seeds: [N] })`.

```js
await explore({ seeds: 40, scenario: async ({ scheduler }) => {
  const db = instrumentDb(createFakeDb({ things: createFakeCollection() }), scheduler);
  const results = await scheduler.run([actorA(db), actorB(db), ...retryStorm({ clients: 8, attempt })]);
  // invariants that must hold in every interleaving
}});
```

Helpers: `createScheduler`, `instrumentDb`, `explore`, `retryStorm` (clients that
back off and retry on retryable errors), `settledValues` (surface an actor
crash). The harness self-tests prove it finds a real lost-update race that a
sequential run never would, and that atomic updates survive every interleaving.

## What is covered

| Area | Scenario | Invariant |
| --- | --- | --- |
| Idempotent writes | 12 concurrent duplicates | Side effect runs exactly once; others replay or get retryable `CONFLICT_IN_PROGRESS` |
| | Same key, conflicting payloads | One winner; the rest get `CONFLICT_IDEMPOTENCY_KEY`/in-progress, never execute |
| | Retry storm after transient failure | Effect committed exactly once; every client converges on the same result |
| | Crashed owner's expired claim | Exactly one contender takes over |
| Stale versions | N editors on version *v* | Exactly one write lands; the rest get a conflict with the current version |
| | Read-modify-write + refetch | No lost update (counter == number of editors) |
| | Legacy unversioned docs | Treated as version 1 and still contend correctly |
| Checkout quotes | 10 concurrent consumers | Exactly one consumes the single-use quote |
| Material lifecycle | 6 actors with competing plans | Committed transitions form a legal chain; `removed` is last |
| Disputes | Reviewers + parallel executors | History is a legal path; payout happens at most once |
| Publication saga | Parallel workers; failure + retry | Each step won once, in order, never repeated or skipped |
| Refunds | Overlapping reconcilers | Refunded amount mirrored onto the purchase exactly once |
| | Worker pool polling the queue | One claim, one on-chain submission |
| | Retry storm on failing dependency | `retryCount` equals processed attempts; nothing submitted |
| Archive (eduvault-archive) | N concurrent duplicate archive submissions | Document ends archived; `searchVisibility` consistent |
| | Archive + restore racing | Final state is either fully archived or fully restored; no split-brain |
| | N archivers on the same CAS version | Exactly one write lands; the rest get `CONFLICT` with current version |
| | Deeply stale archive request | Rejected; document unchanged |
| | Read-modify-write refetch-and-retry on archive | No lost update; `toggleCounter` == number of editors |
| | Archive racing a concurrent metadata PUT | Exactly one write lands at version *v*; other retries at *v+1* |
| | Impersonator vs. real owner racing | Only the verified owner's write lands; impersonators always get `forbidden` |
| | Case-insensitive address matching | Same address in different cases accepted; different address rejected |
| | N workers racing to create a publication saga | Exactly one saga created per idempotency key |
| | Concurrent sagas for different materials | Two distinct sagas; no cross-contamination |
| | Saga failure + retry racing archive transition | Saga state consistent; stale fail is a no-op after step advances |
| | Retry storm on transiently failing archive write | Document archived exactly once; every client converges |
| | Non-retryable authorization failure | Storm stops immediately; no retries; no write lands |
| | Concurrent archive and delete | Final state consistently archived or gone; never corrupted |

## Defects the harness found (and the fixes)

| Defect | Fix |
| --- | --- |
| `withIdempotency` did read → run handler → insert, so concurrent duplicates all ran the handler (and the losers then crashed on the duplicate-key insert) | Claim the key first with an atomic insert (`in_progress`), complete via compare-and-set; duplicates get `CONFLICT_IN_PROGRESS`; abandoned claims expire (`lockMs`); stale records are removed with a conditional delete |
| Materials `PUT` referenced undefined `filter`/`currentVersion`, so the stale-version check never ran (and the handler threw) | New `versionedWrite.js` compare-and-set on `version`; route uses it and returns 409 `CONCURRENCY_CONFLICT` |
| `finalizeSettlement` could run twice concurrently, each applying `$inc refundedAmount` | Purchase mirroring is gated on `appliedRefundIds` not containing the refund (exactly-once) |
| `executeDisputeRefund` could pay out twice when two executors read `approved` | Lease-based execution claim before moving money; released on failure |
| `failSagaStep` accepted a stale state, so a later retry could rewind a completed step | Fail is a compare-and-set on the observed state; retry also matches the recorded failure point |

## Operational edge cases and failure modes

- **`CONFLICT_IN_PROGRESS` (409, retryable).** A duplicate arrived while the
  first request is running. Clients should retry with the *same* key and
  payload after a short delay and will receive the stored result.
- **Handler outlives `lockMs` (default 2 min).** Another caller may take the
  claim over and run the handler again. Set `lockMs` above the handler's
  worst-case duration, and keep handlers themselves idempotent where money moves.
- **Handler succeeded but the completion write failed.** The key stays
  `in_progress` until the lock expires, then the handler may run again. This is
  the at-least-once edge; downstream effects should carry their own dedupe key.
- **Failed outcomes are retryable** with the same key (the stale `failed`
  record is removed by the next caller).
- **`CONCURRENCY_CONFLICT` on material update.** The client's `expectedVersion`
  (or `If-Match`) is behind. Reload, re-apply the change, resend. If no version
  is supplied the write is still compare-and-set against the version just read.
- **Dispute `refund_execution_in_progress`.** Another executor holds the lease
  (5 min default, `claimLeaseMs`). If it crashed, the lease expires and the
  next call proceeds; if it paid but crashed before marking `executed`, check
  the payment reference before re-running (the payout function receives a
  stable `disputeId`).
- **Refund audit chain.** `recordRefundAuditEvent` reads the last entry then
  inserts, so two simultaneous events for one refund can fork the hash chain.
  The scenarios deliberately do not assert on it; `verifyRefundAuditChain`
  detects a fork. Fixing it needs a unique `(refundId, seq)` index plus retry.
- **Harness limits.** It interleaves at database-call boundaries with atomic
  single-document operations. It does not model multi-document transactions,
  replication lag or process crashes between statements; crash recovery is
  covered by the lifecycle tests.

## Archive route: known races and hardening recommendations

The `POST /api/creator/materials/[id]/archive` route performs a **blind
`updateOne`** (no optimistic version check). The tests in
`archiveSubmissions.test.js` document the resulting behaviour and recommend
mitigations:

| Race | Current behaviour | Recommended fix |
| --- | --- | --- |
| N duplicate archive requests | All land (idempotent flag write); `searchVersion` advances N times | Wrap in `updateWithExpectedVersion` so only one write lands per version step |
| Archive + restore racing | Last committed write wins; no split-brain | Acceptable for a flag toggle; add CAS if ordering must be authoritative |
| Archive racing a metadata PUT | Both read the same version and one silently overwrites the other | Both routes must use `updateWithExpectedVersion`; the loser retries at the new version |
| Concurrent archive + delete | Archiver may read the document before it is deleted; `updateOne` on a gone doc is a silent no-op | Check `matchedCount === 1` and return 404 when the doc vanished between read and write |
| Publication saga duplicate creation | Without a unique index on `idempotencyKey`, two workers can each insert a saga | Add a unique index on `publication_sagas.idempotencyKey`; `ensureOneSaga` pattern in the tests shows the correct guard |

## Rollback and recovery

- All fixes are additive or tighten a guard; stored documents stay compatible.
  New optional fields: `idempotency_keys.claimId/lockExpiresAt`,
  `purchases.appliedRefundIds`, `disputes.executionClaimedAt/By`.
- **Stuck idempotency key** (`in_progress` after a crash): wait for
  `lockExpiresAt`, or delete the record
  (`db.idempotency_keys.deleteOne({ _id: "<key>", status: "in_progress" })`) after
  confirming the side effect did not happen.
- **Dispute stuck behind a lease:** clear it with
  `db.disputes.updateOne({ _id }, { $set: { executionClaimedAt: null } })` after
  verifying no payout was made.
- **Purchases refunded before this change** have no `appliedRefundIds`; the
  first re-finalization of an already-settled refund would count again, so do
  not manually re-run `finalizeSettlement` for refunds settled before deploy
  unless `entitlementRevoked` is false.
- **Revert path:** reverting the commit restores the previous behavior; the new
  fields are ignored by old code.
- **Adding a scenario:** write actors, run them under `explore`, assert the
  invariant after `scheduler.run`. Include a case that *should* fail on a naive
  implementation (see `harness.test.js`) so the scenario proves it can detect
  the race.
