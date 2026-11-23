# Deterministic Replay for Multi-Actor Mutations

`test/concurrency/multiActorReplay.test.js` replays a fixed multi-actor scenario under 20 seeded interleavings and checks the outcome per seed. It extends the #983 replay tests in `deterministicReplay.test.js` with a shared versioned document, a retrying writer and an unauthorized actor on one collection.

Harness: [`test/concurrency/harness.js`](../test/concurrency/harness.js). Background: [concurrency-harness.md](concurrency-harness.md).

## Scenario

- One versioned document in `ledger` (`count`, `version`).
- `writer_a`: read, versioned increment, commit.
- `writer_b`: same, but its first attempt throws a transient failure after reading, then retries.
- `intruder`: rejected as unauthorized before any read or write.

## Invariants per seed

| Path | Assertion |
| --- | --- |
| Normal | Both writers commit once; `count` is 2 (no lost update, nothing double-counted) |
| Failure | The injected transient failure happens exactly once and `writer_b` recovers |
| Retry | Stale-version conflicts and transient failures are retried until success |
| Authorization | The intruder never writes and `count` is unchanged by it |
| Replay | The same seed gives the same trace, interleaving and final state |

## Edge cases

- **Stale version:** a writer that read version *v* and loses the race gets a `CONFLICT`, re-reads, and retries. It never overwrites.
- **Transient failure before write:** nothing is written, so retrying cannot double-apply.
- **Unauthorized actor:** rejected before any collection call, so it cannot leave partial state.
- **Scheduler step limit:** a runaway interleaving fails with the seed attached rather than hanging.

## Recovery and rollback

No state needs rolling back: a failed attempt performs no write, and a conflicting write is rejected by the version check. To reproduce a failure, re-run the single seed reported in the `[seed=N]` message, e.g. by setting the seed list to `[N]`.

## Running

The test is picked up by `vitest run test/concurrency`. The scenario is seeded, so a failure is reproducible from its seed alone.
