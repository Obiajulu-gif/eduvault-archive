# Lifecycle State Machines

Every long-lived entity that gates access or money has an **explicit, exported
transition table**. An undeclared edge is never reachable: it is rejected
deterministically (same input, same error/reason, no write, no audit entry).

The tests live in
[`src/lib/__tests__/lifecycleStateMachines.test.js`](../src/lib/__tests__/lifecycleStateMachines.test.js).
They declare the expected edges as literals, independent of the implementation,
and check **every** `(from, to)` pair, so adding, removing, or mis-wiring an
edge fails a test.

Run: `npx vitest run src/lib/__tests__/lifecycleStateMachines.test.js`

## Material lifecycle (`src/lib/db/materialLifecycle.js`)

| From | Allowed next states |
| --- | --- |
| `draft` | `active` |
| `active` | `paused`, `archived`, `suspended`, `retired`, `removed` |
| `paused` | `active`, `archived`, `suspended`, `retired`, `removed` |
| `archived` | `active`, `retired`, `suspended`, `removed` |
| `suspended` | `active` (moderation overturned), `removed` |
| `retired` | `active` (restore), `removed` |
| `removed` | — **terminal** (legal tombstone) |

- **Terminal:** `removed` only (`TERMINAL_STATES`, `isTerminalState`).
- **Recovery edges:** `retired|archived|suspended|paused -> active`. Each
  restores the legacy flags the forward edge set (`isDeleted`/`deletedAt`/…,
  `archived`, `moderationStatus`).
- **Errors:** `err.code` is `INVALID_LIFECYCLE_TRANSITION`,
  `LIFECYCLE_CONCURRENT_MODIFICATION`, or `MATERIAL_NOT_FOUND`.

Behavior hardened in this change:

- Writes are compare-and-set on the state that was validated, so a concurrent
  writer cannot turn a legal transition into an illegal one (previously the
  update was unconditional and the last writer won, e.g. resurrecting a
  `removed` material). Legacy documents with no `lifecycleState` are treated as
  `draft`.
- A same-state request is an idempotent no-op (no write, no audit). Previously
  `retired -> retired` overwrote the original `deletedAt`/`deletedBy`.
- Unknown states are never valid, even for identity (`bogus -> bogus`).

## Refund (`src/lib/refunds/refundWorkflow.js`)

| From | Allowed next states |
| --- | --- |
| `requested` | `approved`, `rejected` |
| `approved` | `submitting` |
| `submitting` | `pending`, `settled`, `failed`, `approved` (retry) |
| `pending` | `pending` (re-poll), `settled`, `failed`, `approved` (retry) |
| `failed` | `approved` (admin retry), `rejected` |
| `settled` | — **terminal** |
| `rejected` | — **terminal** |

`REFUND_TRANSITIONS` is enforced inside the internal `transition()` helper:
calling it with an undeclared edge throws `InvalidRefundTransitionError`
(`code: INVALID_REFUND_TRANSITION`) instead of silently matching nothing.
Public operations (`approveRefund`, `rejectRefund`, `retryFailedRefund`,
`processApprovedRefund`, `finalizeSettlement`, `reconcileRefund`) act only on
their own source states and otherwise report `already_transitioned`,
`not_in_failed_state`, `already_claimed` or `not_settled` without changing the
document.

Recovery paths covered by tests:

| Situation | Path |
| --- | --- |
| Treasury short / build failed / rejected submit | `submitting -> approved` with `retryCount + 1` |
| Retry budget exhausted | `submitting -> failed` → admin `retryFailedRefund` → `approved` (budget reset) |
| Ambiguous submission (timeout) | `submitting -> pending` → reconcile by tx hash: `settled`, `approved` (ledger failed / timed out) or stay `pending` |
| Worker crashed in `submitting` with no tx hash | `submitting -> approved` via `reconcileRefund` |
| Crash after `settled` before entitlement revoke | `reconcileRefund` converges; revoke runs exactly once |
| Denying a failed refund | `failed -> rejected` |

## Dispute (`src/lib/refunds/disputeWorkflow.js`)

| From | Allowed next states |
| --- | --- |
| `opened` | `reviewing` |
| `reviewing` | `approved`, `denied` |
| `approved` | `executed` |
| `denied` | — **terminal** |
| `executed` | — **terminal** |

`DISPUTE_TRANSITIONS` / `isValidDisputeTransition` were extracted from an
inline object with identical content. `approved` additionally requires a
complete evidence bundle. Updates are compare-and-set; the loser of a race gets
`concurrent_status_mutation` and no duplicate history entry.

Recovery: if the refund call fails in `executeDisputeRefund`, the dispute stays
`approved` and the call can simply be repeated. After `executed`, replays are
refused, so no second payout is issued by this module.

## Publication saga (`src/lib/backend/publicationSaga.js`)

Forward steps: `pending -> upload_done -> ipfs_pinned -> soroban_registered ->
chain_finalized -> indexed -> complete`. Any non-terminal step may move to
`failed`. `failed` may only return to the step recorded in
`lastError.failedAt` (`retrySagaFromFailure`). `complete` is **terminal**.

Fixes made while formalising it:

- `transitionSagaState` contained two `$set` keys in one object literal, so the
  first (the `state` advance) was silently discarded and the saga never
  advanced. They are merged into a single `$set`.
- `failSagaStep` only fails the step the caller observed (compare-and-set on
  `state`); a late or stale report on a saga that advanced, completed or
  already failed is a no-op, so the recorded failure point is always real.
  `retrySagaFromFailure` also matches that failure point, so a stale retry
  cannot rewind a saga that failed again.
- `completeSaga` only promotes an `indexed` saga (previously any state,
  including `failed`).
- `compensateSaga` refuses a `complete` saga (it used to flip it to `failed`).
- New `retrySagaFromFailure(sagaId)`: returns the updated saga, or `null` when
  the saga is not failed, has no valid failure point, or was already
  compensated (external resources were rolled back, so resuming is unsafe).

## Operational edge cases and failure modes

- **Racing writers** (reviewers, workers, retry storms): compare-and-set means
  exactly one wins; the loser gets a typed error/`null`/reason and nothing is
  written. Callers should re-read and decide; do not blindly retry the same
  edge.
- **Stuck `submitting`** (worker died): picked up by
  `getRefundsAwaitingReconciliation` after the stale cutoff; recovered to
  `approved` (no hash) or reconciled by hash.
- **Stuck `pending`**: re-polled until confirmed/failed, or until
  `REFUND_PENDING_TIMEOUT_MS`, then rebuilt via `approved`.
- **`failed` refund**: needs a human decision — `retryFailedRefund` or
  `rejectRefund`. It is never auto-retried.
- **Material `removed`**: irreversible by design. A mistaken removal cannot be
  undone through this API; restore from backup/legal-hold process and
  document it as an incident.
- **Saga `failed` after compensation**: not resumable. Create a new saga with a
  new idempotency key after fixing the cause.
- **Unknown/corrupt stored states** are never treated as valid; the operation
  fails with the invalid-transition error instead of passing through.
- **Out of scope:** `workflowOrchestrator` (fencing-token workflow states) has
  its own concurrency model and is not covered by this matrix.

## Rollback and recovery

- The changes are additive except the stricter guards above. To roll back
  behavior, revert the commit; no data migration is involved and stored
  documents use the same state strings as before.
- If a legitimate flow starts failing with `INVALID_*_TRANSITION`, the table
  is the contract: add the edge to the table **and** the expected-edge literal
  in the test in the same change.
- To repair an entity stuck by a past bug (e.g. a saga whose `state` never
  advanced because of the duplicate-`$set` defect), inspect `stepProofs`
  and set `state` to the first step without a proof using a one-off, audited
  script; then let the worker resume.
- `LIFECYCLE_CONCURRENT_MODIFICATION` is safe to surface as HTTP 409; the
  caller should re-fetch the material and retry only if the edge is still
  legal.
