# User-Visible Operation History (#882)

`GET /api/operations/history` gives each user a reliable history of their
important operations. Maintainer identities and internal metadata stay hidden.

Implementation: [`src/lib/operations/operationHistory.js`](../src/lib/operations/operationHistory.js).

## Source of truth

The history is a **read model over the tamper-evident `audit_ledger`**. It
doesn't write anything. Every operation it shows was already appended by the
writer that performed it (`appendAuditRecord` / `appendCriticalMutation`), so
the history can't drift from what happened. Hash-chain verification
(`verifyAuditRecords`) still covers every row it reads.

## Visibility rules

Only actions registered in `OPERATION_HISTORY_EVENTS` are ever shown. Each
one names the single rule that makes it visible:

| Rule | A ledger row belongs to the user when… | Examples |
| --- | --- | --- |
| `actor` | `actor` is one of the user's identities (user id, wallet in any stored casing) | purchases, listing changes, verification submitted |
| `subject` | `target` is `{ type: "user", id: <user identity> }` | role changes, suspension, identity links |
| `owner` | `target` is a resource the user owns, resolved by `OWNED_RESOURCE_RESOLVERS` | refund requested, approved, rejected, settled |

| Category | Event types |
| --- | --- |
| `purchase` | `purchase.started`, `purchase.completed`, `purchase.cancelled`, `purchase.payment_confirmed` |
| `refund` | `refund.requested`, `refund.approved`, `refund.rejected`, `refund.settled`, `refund.access_revoked` |
| `content` | `material.updated`, `material.retired`, `material.restored` |
| `account` | `verification.submitted`, `account.role_changed`, `account.suspended`, `account.reactivated` |
| `identity` | `identity.linked`, `identity.unlinked`, `identity.link_failed` |

Internal-only actions are never shown. Examples: `refund.submitting`,
`refund.retry_scheduled`, `refund.submission_ambiguous`, `purchase.expired`
(system sweeps), moderation, `identity.unlink_denied`, and support/approval
records.

## Redaction

Redaction is also allow-list. An event is built from scratch and never copied
from the ledger row:

```json
{
  "id": "671f…",
  "type": "refund.approved",
  "category": "refund",
  "occurredAt": "2026-10-20T12:00:00.000Z",
  "performedBy": "eduvault",
  "resource": { "type": "refund", "id": "671e…" },
  "details": { "status": "approved" }
}
```

- `performedBy` is `"you"` or `"eduvault"`. Maintainer and system actor ids are never returned.
- `details` holds only the keys registered for that event. For example, a role change exposes `newRole` but not the permission `diffReport`.
- Never read into the response: `actor`, `actorProof`, `intentHash`, `before`/`after` snapshots, `previousHash`/`recordHash`, `operationId` (it can embed maintainer ids), `sequence`, `reason` (maintainer notes), correlation ids.

**Deleted records.** An operation on a material that has since been
soft-deleted or removed stays in the history, but its details are withheld:
`resource: { "type": "material", "id", "available": false }`. Live materials
include `title` and `"available": true`.

## API

`GET /api/operations/history` requires an active session and returns
`Cache-Control: private, no-store`.

| Param | Description |
| --- | --- |
| `category` | One of the categories above |
| `type` | One of the event types above |
| `from`, `to` | ISO-8601 bounds on `occurredAt` (inclusive) |
| `limit` | 1–100, default 20. Larger values are capped at 100 |
| `cursor` | `nextCursor` from the previous page |

```json
{ "events": [ … ], "nextCursor": "eyJzIjo0Miwi…", "hasMore": true }
```

Pagination is keyset on the ledger's unique, monotonic `sequence`. Pages don't
skip or repeat rows when new operations are appended between requests. A
cursor is bound to the filters that produced it. Reusing it with different
filters, or tampering with it, returns `400`. Invalid parameters return RFC
9457 problem details with `400`, and missing sessions return `401`.

## Adding an event

1. Make sure the writer appends a ledger row with a stable `action`, and an
   `actor`/`target` that one of the three rules can attribute.
2. Register it in `OPERATION_HISTORY_EVENTS` with a user-facing `type`, a
   `category`, its visibility rule, an optional `resource`, and the `details`
   keys that are safe to show.
3. For a new `owner` resource type, add a resolver to `OWNED_RESOURCE_RESOLVERS`.
4. Add a case to `tests/backend/operation-history.test.mjs`.

## Indexes and performance

- `audit_ledger { actor: 1, sequence: -1 }` (new) serves the `actor` rule.
- `audit_ledger { "target.type": 1, "target.id": 1, sequence: 1 }` (existing) serves the `subject` and `owner` rules.
- Each `$or` branch is an index scan ordered by `sequence`, so a page costs O(limit) index entries in the common case. Date filters are applied as a residual filter.
- The owner rule first resolves the user's refund ids through the new `refunds { buyerAddress: 1 }` index: O(r) in the user's refunds.

## Tests

```bash
npx tsx --test tests/backend/operation-history.test.mjs
npx vitest run src/app/api/__tests__/operationHistory.route.test.js
```
