# Safe Ownership Transfer

Material ownership moves in two steps: the owner **proposes**, the named recipient **accepts**. An offer nobody answers **expires**. Ownership does not change until the recipient accepts.

Code: `src/lib/ownership/ownershipTransfer.js`. Routes: `POST /api/materials/[id]/transfer` (propose) and `POST /api/ownership-transfers/[transferId]` (accept, decline or cancel). Tests: `src/lib/ownership/__tests__/ownershipTransfer.test.js`.

## State machine

```
            propose
               │
               ▼
          ┌─────────┐  recipient declines   ┌──────────┐
          │ pending │ ────────────────────▶ │ declined │
          └─────────┘                       └──────────┘
            │  │  │   owner/admin cancels   ┌───────────┐
            │  │  └───────────────────────▶ │ cancelled │
            │  │      TTL passes            └───────────┘
            │  └───────────────────────────▶ expired
            │ recipient accepts
            ▼
        ┌───────────┐  owner swap lands   ┌──────────┐
        │ accepting │ ──────────────────▶ │ accepted │
        └───────────┘                     └──────────┘
            │ owner changed / material deleted
            ▼
         failed
```

`accepted`, `declined`, `cancelled`, `expired` and `failed` are terminal. `accepting` is a short lease (2 minutes) held while the material document is updated.

## Authorization

| Action  | Who                                   | Anyone else                                  |
| ------- | ------------------------------------- | -------------------------------------------- |
| propose | current owner (`materials.userAddress`) | 403 `AUTH_FORBIDDEN` (`not_owner`)           |
| accept  | the named recipient only              | owner: 403 `wrong_party`; strangers: 404     |
| decline | the named recipient only              | same as accept                               |
| cancel  | the proposing owner, or an admin      | recipient: 403; strangers: 404               |

Addresses compare case-insensitively. Strangers get 404 rather than 403 so a transfer id does not confirm that the transfer exists. All routes need an authenticated session with `creator:manage`, so the recipient needs a creator account.

A material cannot be proposed for transfer while deleted, `suspended` or `quarantined`, so a takedown or fraud hold cannot be handed to a new owner. A creator cannot transfer to themselves.

## Guarantees

- **One live transfer per material.** A partial unique index on `ownership_transfers.materialId` (states `pending`/`accepting`) rejects a competing proposal; a different recipient gets 409 `CONFLICT_IN_PROGRESS`.
- **Proposals are idempotent.** Re-sending the same owner → recipient proposal returns the live transfer with `replayed: true`.
- **Accepts are idempotent.** Accepting an already-accepted transfer returns `replayed: true` and does not touch the material again, so the material `version` is bumped once.
- **No double swap.** Accept first claims `pending → accepting` with a conditional update, then swaps the owner with a filter on the exact previous owner. Two concurrent accepts: one wins, the other gets 409 `accept_in_progress`.
- **Stale offers are dead.** An offer past `expiresAt` cannot be accepted. Expiry is applied lazily on every read/write and by the sweep, so a missed cron never lets an old offer through.
- **Audit trail.** Every transition appends `{action, actor, at}` to the transfer's `history`. On accept, the material records `previousOwnerAddress`, `ownershipTransferredAt` and `ownershipTransferId`. The route also writes `auditLog` events and refreshes the search projection and catalog cache.

## Edge cases

| Case | Behavior |
| ---- | -------- |
| Owner changed between propose and accept | Accept fails with 409 `owner_changed`; transfer becomes `failed`. The owner must propose again. |
| Material deleted between propose and accept | Same as above. |
| Offer expired | 409 `transfer_expired`; transfer becomes `expired`. Owner proposes again. |
| Proposal TTL | Default 72h, minimum 1h, maximum 14 days (`ttlMs`). |
| Recipient accepts after owner cancelled | 409 `transfer_not_pending`. |
| Owner cancels after recipient accepted | 409; accepted transfers are final. Reverse with a new transfer in the other direction. |
| Legacy rows with only `ownerAddress` | Not transferable (403 `not_owner`) until `userAddress` is backfilled; the owner swap matches one exact stored value. |
| Purchases, entitlements, payouts | Unchanged. Existing buyers keep access. Future payouts resolve to the new `userAddress`; historical payouts keep their original creator. |

## Failure, retry and recovery

Writing the transfer and the material is two updates with no transaction, so the order is chosen so every crash point is recoverable:

1. `pending → accepting` (lease 2 min). Crash here: nothing has moved; the lease expires.
2. Material owner swap. Crash here: the swap either landed or it did not.
3. `accepting → accepted`. Crash here: material already has the new owner.

If step 2 throws, the accept rolls the claim back to `pending` immediately, and the recipient retries. If the process dies, `accepting` outlives its lease and is settled from the material:

- material owner is the recipient and `ownershipTransferId` matches → mark `accepted` (**roll forward**)
- otherwise → back to `pending`, or `expired` if the offer is past its TTL (**roll back**)

A recipient retrying accept settles a stale lease on its own. Operators can sweep with:

```js
import { recoverStuckTransfers } from "@/lib/ownership/ownershipTransfer";
await recoverStuckTransfers(db); // → { expired, completed, rolledBack }
```

It is safe to run repeatedly and from several workers. Run it every few minutes; it is only needed to tidy transfers nobody retries. From cron: `MONGODB_URI=... npm run transfers:recover` (logs the `{ expired, completed, rolledBack }` summary; exit code 1 on failure).

### Undoing a completed transfer

There is no "undo". If a transfer was made in error, the new owner proposes a transfer back. In an incident an operator can set `userAddress` back to `previousOwnerAddress` on the material, bump `version`, and re-enqueue the search projection; record the reason in the admin audit log.

## Compatibility and migration

Additive only. No existing route, field or index changes. New pieces:

- collection `ownership_transfers` and its indexes (registered in `REQUIRED_INDEXES`; `ensureIndexes()` creates them on deploy),
- two routes,
- extra fields on a material only after a transfer completes.

Rollback of the feature: remove or disable the two routes. Leave the collection and any `ownership*` fields in place; no code outside this feature reads them. Transfers that were `pending` simply stop being actionable and `expired` in the data on the next sweep or read.
