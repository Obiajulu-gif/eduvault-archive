# Idempotent Side-Effect Dispatcher (#945)

`src/lib/sideEffects/dispatcher.js` executes side effects (receipt emails,
creator webhooks, payout notifications, indexer syncs) so they are **keyed,
retryable, observable and recoverable from a dead-letter queue without
duplicate user-visible actions**.

## Why, given the existing outbox?

`src/lib/backend/outbox.js` + `sideEffectWorker.js` guarantee an intent is
eventually attempted, but the retry unit is the whole intent:

- a webhook intent with 3 URLs where 1 fails is retried for **all 3** URLs;
- a dead-letter replay re-runs work that already landed;
- every error is retried until `maxAttempts`, even ones that can never succeed;
- a worker whose lease expired mid-delivery can still act after takeover.

The dispatcher fixes these at the handler level. It is additive and does not
change the outbox collection, its routes or the worker.

## API

```js
import { createSideEffectDispatcher, PermanentSideEffectError } from '@/lib/sideEffects/dispatcher';

const dispatcher = createSideEffectDispatcher({
  store,                 // defaults to createMemorySideEffectStore()
  workerId: 'worker-1',
  onEvent: (e) => recordMetric(`side_effect.${e.event}`, e), // never throws into dispatch
  config: { maxAttempts: 5, leaseMs: 60_000, initialBackoffMs: 1_000, maxBackoffMs: 60_000 },
  handlers: {
    webhook: async (ctx) => {
      for (const url of ctx.payload.urls) {
        await ctx.step(`deliver:${url}`, (idempotencyKey) =>
          send(url, ctx.payload.body, { headers: { 'Idempotency-Key': idempotencyKey } }));
      }
    },
    email: async (ctx) => {
      if (ctx.payload.unsubscribed) throw new PermanentSideEffectError('unsubscribed');
      return ctx.step('send', (key) => mailer.send({ ...ctx.payload, messageId: key }));
    },
  },
});

await dispatcher.dispatch({ key: `purchase:${id}:receipt`, type: 'email', payload });
await dispatcher.processDue();                        // scheduled retries + expired leases
await dispatcher.replayDeadLetter(key, { operator: admin.id, reason: 'SMTP restored' });
await dispatcher.listDeadLetters();
await dispatcher.stats();                             // { pending, in_progress, retry_scheduled, succeeded, dead_letter }
```

## Guarantees

| Property | Mechanism |
| :--- | :--- |
| Keyed | `key` is required (`[A-Za-z0-9:._-/]{1,200}`). A repeat dispatch of a succeeded key returns the stored result (`duplicate: true`) without calling the handler. Same key + different type/payload → `IdempotencyConflictError`. Payload comparison is key-order-insensitive. |
| No duplicate user-visible actions | Handlers wrap each action in `ctx.step(id, fn)`. Completed steps are persisted and skipped by retries, lease takeovers and replays. Each step gets a stable downstream idempotency key `${key}:${id}`. |
| Retryable | Exponential backoff (`initialBackoffMs * multiplier^(attempt-1)`, capped). Errors with `retryable === false` (e.g. `PermanentSideEffectError`) dead-letter immediately. |
| Fenced | Execution holds a lease. A step re-checks the lease before acting, and results/steps are only written while the worker still owns the lease, so a stalled worker cannot act or overwrite the outcome after takeover (`lease_lost` event). |
| Observable | Events: `enqueued`, `attempt_started`, `step_completed`, `step_skipped`, `succeeded`, `retry_scheduled`, `dead_lettered`, `replayed`, `duplicate_suppressed`, `idempotency_conflict`, `lease_lost`. Each record keeps a bounded `history` (default 50) with worker ids, errors and operator/reason for replays. |
| Recoverable | `replayDeadLetter` requires an operator and reason, only acts on `dead_letter` (compare-and-set), resets attempts, increments `replayCount`, and keeps completed steps. |

## Store contract (for a MongoDB adapter)

Every method must be atomic per record. Mapping for a `side_effect_dispatches`
collection with a unique index on `key`:

| Method | MongoDB |
| :--- | :--- |
| `insertIfAbsent(record)` | `updateOne({ key }, { $setOnInsert: record }, { upsert: true })`, then `findOne` |
| `claim(key, { owner, now, leaseUntil })` | `findOneAndUpdate({ key, $or: [{ status: {$in:['pending','retry_scheduled']}, nextAttemptAt: {$lte: now} }, { status: 'in_progress', leaseExpiresAt: {$lte: now} }] }, { $set: {...}, $inc: { attempts: 1 } })` |
| `updateIfOwner(key, owner, patch)` | `findOneAndUpdate({ key, status: 'in_progress', leaseOwner: owner }, { $set: patch })` |
| `updateIfStatus(key, status, patch)` | `findOneAndUpdate({ key, status }, { $set: patch })` |
| `recordStep(key, owner, stepId, step)` | `findOneAndUpdate({ key, leaseOwner: owner, status: 'in_progress', ['steps.'+stepId]: { $exists: false } }, { $set: { ['steps.'+stepId]: step } })` |
| `listDue`, `listByStatus`, `countByStatus` | indexed `find` / `aggregate` on `{ status, nextAttemptAt }` |

## Edge cases and failure modes

- **Crash after the downstream call, before the step is recorded:** the only
  window left for a duplicate. Close it by forwarding the step idempotency key
  to the provider (email `Message-ID`, webhook `Idempotency-Key` header,
  Stellar memo / tx hash check). The dispatcher is at-least-once per step;
  provider-side dedupe makes it effectively once.
- **Concurrent dispatch of one key:** exactly one worker claims it; the others
  get `{ status: 'in_progress', duplicate: true, executed: false }`.
- **Lease shorter than the handler:** another worker may take over; the
  stalled one is fenced. Size `leaseMs` above the slowest step's p99.
- **Observability hook throws:** swallowed; dispatch outcome unchanged.
- **Handler not registered / malformed key:** rejected at enqueue, nothing stored.
- **Payload contains secrets:** records store the payload; prefer references
  (purchase id) over raw secrets, as with the existing outbox.

## Rollout, rollback and recovery

1. Ship the module (this change) — no runtime callers yet.
2. Add a Mongo store implementing the table above with its unique index.
3. Route one effect type (e.g. creator webhooks fan-out) through the
   dispatcher behind a feature flag, keyed by the outbox `deliveryId`, so both
   paths share the key and cannot double-send.
4. Watch `dead_lettered` / `lease_lost` / `duplicate_suppressed` rates.

**Rollback:** turn the flag off — effects go back through the existing worker;
the dispatcher records are left in place and are harmless. **Recovering dead
letters:** fix the cause, then `listDeadLetters()` and `replayDeadLetter(key,
{ operator, reason })` per record; replays never repeat completed steps and are
recorded in the record history for audit.

## Tests

- `src/lib/__tests__/sideEffectDispatcher.test.js` (Vitest): duplicate suppression,
  key conflicts, backoff, partial fan-out retry, permanent errors, max attempts,
  audited replay, concurrent workers, crash/lease takeover with fencing, faulty hook.
- `tests/backend/side-effect-dispatcher.test.mjs` (`npm run test:backend`).
