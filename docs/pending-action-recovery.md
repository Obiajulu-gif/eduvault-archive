# Pending Action Recovery

Deterministic recovery workflow for **stuck pending actions** (Issue #828).
A pending action is any deferred side effect the app has accepted but not yet
completed — a checkout confirmation, an index write, a delivery job, and so on.
Before this workflow these records could sit in `pending` forever with no way
for a user or maintainer to see or resolve them.

Implementation: [`src/lib/recovery/pendingActions.js`](../src/lib/recovery/pendingActions.js)
Tests: [`src/lib/recovery/__tests__/pendingActions.test.js`](../src/lib/recovery/__tests__/pendingActions.test.js)

Run the focused tests:

```bash
npx vitest run src/lib/recovery
```

## States

| State               | Meaning |
| ------------------- | ------- |
| `pending`           | Accepted; not yet attempted, or the first attempt is in flight. |
| `retryable`         | A previous attempt failed but the retry budget remains. |
| `failed`            | Retries exhausted (or permanently unrecoverable). |
| `resolved`          | An automatic retry (or the user) completed the action. Terminal. |
| `manually_reviewed` | A maintainer resolved it out-of-band, with a reason. Terminal. |

## Transitions

```
       ┌──────────► resolved ◄──────────┐
       │               ▲                │
  pending ──► retryable ─┘               │
       │          │                      │
       └──────────┴──► failed ───────────┘
       │                                 │
       └──────────► manually_reviewed ◄──┘
```

`resolved` and `manually_reviewed` are terminal. Any other transition throws
`PendingActionTransitionError` and **does not** write an audit entry.

| From        | Allowed to |
| ----------- | ---------- |
| `pending`   | `retryable`, `failed`, `resolved`, `manually_reviewed` |
| `retryable` | `retryable`, `failed`, `resolved`, `manually_reviewed` |
| `failed`    | `retryable`, `resolved`, `manually_reviewed` |
| `resolved`  | — (terminal) |
| `manually_reviewed` | — (terminal) |

## Recovery actions

All actions are **pure**: they take a record and return a new record plus the
audit entry (`{ ok, action, audit, auditResult, from, to }`). Persisting the
returned `action` is the caller's responsibility, which keeps the machine
deterministic and testable without a database.

### `retry(action, attemptFn, options?)`

Runs `attemptFn(action, attempt)` once, records the attempt, and transitions:

- **success** → `resolved`
- **failure** with attempts remaining → `retryable`
- **failure** with the retry budget exhausted → `failed`

A failed attempt never throws; the failure is returned as state. Options:
`now`, `actor`, `reason`, `maxAttempts`, `onAudit`.

### `markResolved(action, options?)`

User recovery path: mark a non-terminal action `resolved` without an automatic
retry (e.g. the user confirms the side effect landed).

### `resolveManually(action, { actor, reason, ...options })`

Maintainer recovery path. **Requires** a non-empty `actor` and `reason`, and
lands in `manually_reviewed` (not `resolved`) so automatic and human resolution
stay distinguishable in the audit trail.

## Configuration

| Env var | Default | Purpose |
| ------- | ------- | ------- |
| `PENDING_STALE_MS` | `900000` (15 min) | Age after which a non-terminal action is reported stale. |
| `PENDING_ACTION_MAX_ATTEMPTS` | `3` | Retry budget before `retry()` fails an action. |

Both are env-overridable and can also be passed per call (`staleThresholdMs`,
`maxAttempts`) for tests. `resolveStaleThresholdMs()` / `resolveMaxAttempts()`
expose the resolution logic.

## Diagnostics

`classify(action, { now, staleThresholdMs })` returns a **sanitized** summary —
`{ id, type, state, attempts, createdAt, lastAttemptAt, ageMs, stale, terminal,
thresholdMs }`. It deliberately omits the payload, actor identity, and any
credentials, so it is safe to expose.

`listStalePending(source, { now, threshold, limit })` accepts an array, a
`Map`, `{ records: [...] }`, or a Mongo-like `db` (queried via the
`pending_actions` collection) and returns the non-terminal records past the
threshold, newest-stale first, as sanitized summaries.

```js
import { listStalePending, PENDING_STALE_MS } from '@/lib/recovery/pendingActions';

const stale = await listStalePending(db, { now: new Date(), threshold: PENDING_STALE_MS });
// [{ id, type, state, attempts, ageMs, stale: true, ... }]
```

## Audit

Every successful transition writes exactly one audit entry:

```js
{
  event: 'pending_action_recovery',
  actionId, actionType, materialId,
  actor, from, to, outcome,
  attempt, reason, error, timestamp
}
```

The default sink reuses the existing console logger
([`src/lib/api/audit.js`](../src/lib/api/audit.js)). Pass a custom `onAudit`
function to capture structured entries, or use the tamper-evident ledger sink:

```js
import { createLedgerAuditSink, resolveManually } from '@/lib/recovery/pendingActions';

const onAudit = createLedgerAuditSink({ db, actor: 'maintainer' });
await resolveManually(action, { actor: 'maintainer:alice', reason: 'verified', onAudit });
```

`createLedgerAuditSink` wraps
[`src/lib/backend/auditLedger.js`](../src/lib/backend/auditLedger.js), appending
a hash-chained record with a deterministic operation id (so replaying the same
transition is idempotent in the ledger).

## Relationship to stale-intent cleanup

[`scripts/clean-stale-intents.mjs`](../scripts/clean-stale-intents.mjs) is a
*destructive* garbage collector that deletes stale `checkout_intents`. This
workflow is complementary and non-destructive: it **preserves** the record,
exposes it as stale, and moves it deterministically toward resolution with an
audit trail.
