# Bounded Worker Concurrency (#1118)

`src/lib/workers/boundedConcurrencyRunner.js` is an in-process runner that caps how many jobs execute at once and how many may wait. It complements the count-based admission control in `src/lib/queue/boundedBackpressure.js`, which decides whether a job may be enqueued at all. This runner decides when an admitted task actually runs in the current process.

```js
import { createBoundedConcurrencyRunner } from "@/lib/workers/boundedConcurrencyRunner";

const runner = createBoundedConcurrencyRunner({
  maxInFlight: 4,
  maxPending: 50,
  maxAttempts: 3,
  retryDelayMs: 100,
  authorize: async (principal, name) => principal?.permissions?.includes(name),
});

await runner.submit({ name: "storage:verify-pins", principal, task: ({ attempt }) => verifyPins(attempt) });
```

## Behaviour

| Situation | Result |
| --- | --- |
| Fewer than `maxInFlight` running | Task starts immediately. |
| At `maxInFlight`, pending below `maxPending` | Task waits in FIFO order. |
| Pending queue at `maxPending` | Rejects with `RunnerRejectedError`, `reason: QUEUE_FULL`, `status: 429`, `retryable: true`. Nothing is queued. |
| `authorize` returns false or throws | Rejects with `reason: UNAUTHORIZED`, `status: 403`. The task never runs. |
| Runner closed | Rejects with `reason: CLOSED`. Work already queued still finishes. |
| Task throws | Retried with doubling delay (`retryDelayMs`, `2×`, …) up to `maxAttempts`. |
| Task throws with `retryable === false` | Not retried; rejects on the first failure. |

`snapshot()` returns `inFlight`, `pending`, the configured limits, and counters for `admitted`, `rejected`, `completed`, `retried` and `failed` for dashboards.

## Edge cases

- **Authorization is checked before queueing**, so an unauthorized caller cannot consume pending slots.
- **Backpressure is per process.** Several server instances each allow `maxInFlight`, so the cluster-wide ceiling is `maxInFlight × instances`. Use the Mongo-backed `background_jobs` queue for cross-instance limits.
- **Retries run inside the slot.** A retrying task keeps its in-flight slot during backoff, so a slow dependency reduces throughput rather than piling up work.
- **Tasks are not persisted.** A crash loses pending and in-flight tasks. Anything that must survive a restart belongs in the persisted background job queue (`src/lib/workers/backgroundWorker.js`).

## Recovery and rollback

- On `QUEUE_FULL`, callers should back off and retry; `retryable` and `status: 429` signal this.
- To stop accepting work during a deploy, call `close()`, then wait for `snapshot().inFlight` and `pending` to reach zero.
- The runner has no persisted state, so rollback is removing the call sites; nothing needs migrating.

## Adoption

The module is standalone and not yet wired into an existing worker. To adopt it, wrap the worker's per-job call in `runner.submit` and pass the job's principal through `authorize`.
