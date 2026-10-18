# Conflict-Aware Offline / Multi-Tab Operation Queue

`src/lib/queue/operationQueue.js` + `src/hooks/useOperationQueue.js`

## What it is

A durable, client-side operation queue for user actions that must survive a
refresh, a disconnect, or being performed in one of several open tabs:

- **Survives refresh/disconnect** — every operation is persisted to
  `localStorage` under its own key
  (`eduvault:operation-queue:v1:<operationId>`), so a full reload rehydrates
  queued work. Offline drains are no-ops that keep work pending until
  `navigator.onLine` returns.
- **Detects stale-state conflicts** — an operation may carry a `baseVersion`
  recorded when it was enqueued. Before replaying, `drain()` compares it with
  the current observed version (`versionProvider`); a mismatch moves the
  operation to `conflict` state *without executing it*. A handler can also
  throw `OperationConflictError` (e.g. a 409 from the server).
- **Deterministic retry/discard** — conflicts expose exactly two resolutions:
  `retry` (rebase + requeue) or `discard` (abandon, returning the payload so
  the caller can roll back optimistic UI). Retryable failures follow the same
  deterministic exponential backoff model as the server-side outbox
  (`initialBackoffMs=1s`, `×2`, capped at 60s, ±20% jitter, 5 attempts),
  then land in terminal `failed`.
- **Multi-tab safe** — execution is guarded by a per-operation lease
  (`{ owner: tabId, expiresAt }`, 30s TTL). Only one tab replays a given
  operation; if the owner tab dies mid-flight, another tab reclaims the work
  after the lease expires. A `BroadcastChannel` + `storage` listener keeps
  tabs in sync.

## Usage

```js
const queue = useOperationQueue({
  handler: async (operation) => {
    // Perform the real request. Throw OperationConflictError on 409/stale
    // versions, OperationTerminalError for 4xx that will never succeed, and
    // OperationRetryableError (or any other error) for transient failures.
    return savedApi.update(operation.payload.id, operation.payload, {
      baseVersion: operation.baseVersion,
    });
  },
  versionProvider: async (operation) => {
    // Return the currently observed version for the operation's target.
    // Throwing is treated as retryable (fail closed: never apply unverified work).
    return loadCurrentVersion(operation.type, operation.payload.id);
  },
});

queue.enqueue({
  type: "material.update",
  payload: { id, title: "New title" },
  dedupeKey: `material.update:${id}`,
  baseVersion: material.version,
});
```

`queue.enqueue` returns `null` (and sets `queue.error`) if storage is
unavailable; a `queue_storage_unavailable` error means the work was **not**
persisted — surface that to the user instead of retrying silently.

### Operation states

| Status | Meaning | Terminal |
| --- | --- | --- |
| `pending` | Queued, ready to run | no |
| `in_flight` | Leased by a tab | no |
| `retry_scheduled` | Failed transiently; waiting for `nextAttemptAt` | no |
| `conflict` | Stale state detected; needs `retry`/`discard` | no |
| `applied` | Handler succeeded; `result` stored | yes |
| `failed` | Terminal failure (`maxAttempts` exhausted or terminal error) | yes |
| `discarded` | Conflict resolved by choosing the server's state | yes |

## Operational edge cases

| Case | Behaviour | Operator/UI expectation |
| --- | --- | --- |
| Refresh mid-queue | All operations rehydrate from `localStorage`; `in_flight` leases are reclaimed after TTL expiry | Show "N changes pending" from `queue.openOperations` |
| Offline → online | `useOperationQueue` drains automatically on the `online` event | No user action needed |
| Two tabs queue the same logical action | `dedupeKey` collapses it to one open operation | The second tab sees the first tab's operation |
| Two tabs drain simultaneously | Lease makes one a deterministic `skipped`; no double execution | Work appears applied in both tabs after sync |
| Tab crashes mid-flight | Lease expires (30s); the next drain in any tab reclaims it | Worst case the operation runs twice — handlers must be **idempotent** |
| Stale state (record edited in another tab) | `conflict` state, handler not called | Prompt: "Retry with latest" or "Discard my change" |
| Server rejects with 409 | Handler throws `OperationConflictError`; same UI as above | Same as above |
| Quote/idempotency expiry server-side | Use `OperationTerminalError` for e.g. `QUOTE_EXPIRED`; the operation fails once instead of looping | Prompt the user to re-initiate (e.g. refresh a listing quote) |
| `localStorage` full/blocked | `enqueue` throws `queue_storage_unavailable`; queue is not corrupted | Tell the user nothing was saved |
| > `maxTrackedOperations` (200) | Oldest terminal rows are evicted first; if still full, enqueue is refused | Ask the user to resolve conflicts / `clearCompleted()` |

## Failure modes and diagnosis

- **Handler bug loops**: unknown errors are retryable by design and bounded by
  `maxAttempts` (5). A handler that throws synchronously is still classified
  and counted; after 5 attempts the operation is `failed` with `lastError`.
- **Poisoned operation**: inspect the stored row in DevTools
  (`localStorage["eduvault:operation-queue:v1:<id>"]`), then either
  `queue.resolveConflict(id, "discard")` for conflicts or `clearCompleted()`
  for terminal rows.
- **Clock skew between tabs**: leases use each tab's own clock; a tab with a
  fast clock can hold a lease longer, a slow clock can reclaim early. Work is
  idempotent (see above), so this is a timing nuisance, not a data risk.
- **Version provider outage**: `versionProvider` failures are recorded as
  retryable (`version_probe_failed`) — the queue refuses to apply work it
  cannot verify.

## Rollback / recovery

1. **Per operation**: `discardOperation(id)` marks the operation `discarded`
   and returns it; use `operation.payload`/`operation.result` to undo any
   optimistic UI you applied for that operation.
2. **Bulk**: `clearCompleted()` removes terminal rows only; open work is
   untouched.
3. **Full reset** (support scenario): remove all keys with the prefix
   `eduvault:operation-queue:v1:` and call `refresh()`. Pending user work is
   lost — confirm with the user first.
4. **Recovery after a bad release**: because rows are per-operation keys and
   the module ignores unparseable rows, a corrupt row degrades to "that one
   operation is gone", never a dead queue.

## Tests

- `src/lib/queue/__tests__/operationQueue.test.js` — persistence, dedupe,
  deterministic backoff, conflict detection/resolution, multi-tab leasing and
  reclaim, capacity, cleanup.
- `src/hooks/__tests__/useOperationQueue.test.jsx` — rehydration, auto-drain,
  offline → online flush, conflict retry/discard through the hook, storage
  failure surfacing.

Run: `npx vitest run src/lib/queue src/hooks/__tests__/useOperationQueue.test.jsx`
