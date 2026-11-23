# Deterministic Sorting for Mixed-Status Records and Events

`src/lib/backend/sortContract.js` defines one total order for lists whose items have different statuses and sometimes identical timestamps (#887, #1141). The same set of items always comes out in the same order, whatever order the database, a retry or a cache returned them in. Tests: `tests/backend/sort-contract.test.mjs`.

## Complexity Design
- **Time Complexity**:
  - `sortRecords` / `sortEvents`: $O(N \log N)$ where $N$ is the number of records/events, using JavaScript's native introsort / Timsort implementation with $O(1)$ comparator evaluations.
  - `paginateRecords`: $O(N \log N)$ to sort, followed by $O(K)$ array slice where $K$ is `pageSize`.
  - `pageAfter`: $O(N \log N)$ sort + $O(N)$ linear index search to locate cursor item + $O(\text{limit})$ slice.
  - `verifyOrdering`: $O(N)$ single pass with $O(1)$ set insertions and adjacent pair comparisons.
- **Space Complexity**:
  - $O(N)$ memory overhead to allocate new shallow-copied sorted arrays, ensuring immutable functional semantics that never mutate caller inputs.

## Records: `sortRecords`

1. **Status precedence.** Active (`published`, `active`, `settled`, `completed`) → in progress (`pending`, `draft`, …) → restricted (`suspended`, `quarantined`, `appealed`) → retired (`archived`, `rejected`, `failed`, …) → soft-deleted. Unknown or missing status ranks after all of these. `isDeleted` always ranks last. Status is read from `status`, then `moderationStatus`, then `visibility`.
2. **Timestamp**, newest first by default (`descending: false` for oldest first). Accepts `Date`, ISO strings and epoch milliseconds.
3. **ID**, ascending in code-unit order (so `"10"` sorts before `"9"`; use zero-padded or ObjectId-style ids if you need numeric order). `_id`, `id`, `eventId` and `failureId` are recognised.

## Events: `sortEvents`

Oldest first by default, so a timeline reads in order (`descending: true` for newest first).

1. **Timestamp.** First present of `occurredAt`, `timestamp`, `createdAt`, `at`, or the field named by `timestampField`.
2. **Sequence.** Numeric `sequence` (numeric strings accepted) for events from one source with a monotonic counter.
3. **Lifecycle rank** of the status: started (`requested`, `queued`, `pending`…) → in flight (`processing`, `retrying`…) → terminal (`completed`, `failed`, `cancelled`, `expired`…) → compensating (`rolled_back`, `reverted`, `refunded`). Unknown ranks last. Direction applies to time, sequence and rank together, so descending is the exact reverse of that part of the order.
4. **ID**, ascending.

### Rules common to both

- **Missing or invalid timestamps (and sequences) always sort last**, in both directions, so a record that lost its date never appears at the top of an oldest-first list.
- Status matching ignores case and surrounding whitespace, and ignores inherited object keys (`"constructor"` is an unknown status, not a crash).
- Inputs are never mutated. A non-array returns `[]`; `null`/non-object entries are treated as empty items (unknown status, no timestamp, empty id) instead of throwing.
- Items with identical sort keys *and* identical ids cannot be ordered deterministically. That is a data bug; `verifyOrdering` reports it.

## Authorization

Ordering depends only on the items themselves, never on other items, so a viewer's permission filter cannot change the relative order of what they can see, and cannot be probed through order. Filter first, then sort: `paginateRecords(..., { isVisible })` and `pageAfter(..., { isVisible })` apply the predicate before sorting and counting, so `total`, `totalPages` and `hasMore` never include hidden items.

## Pagination and retries

- `paginateRecords` (page numbers) is unchanged apart from the optional `isVisible`.
- `pageAfter(items, { kind: "records" | "events", after, limit })` is keyset paging: it returns the items strictly after the last item seen. A client that retries a failed request with the same `after` gets the same page, and items inserted or deleted earlier in the list (including the cursor item itself) cannot make it skip or repeat anything. Prefer it over page numbers for lists that change while being read.
- `after` only needs the sort fields (status, timestamp, sequence, id). Serialise it into an opaque cursor in the route, and validate/limit it like any client input.

## Where it is applied

`getPartialFailures` (`src/lib/backend/partialFailures.js`) merges failures from jobs, outbox, purchases, refunds and quarantined content, each queried separately, and then pages them with `offset`/`limit`. The merged list had no overall order, so pages could repeat or skip items. It is now sorted unresolved → retrying → abandoned → resolved, newest `updatedAt` first, then `failureId`.

Other lists that sort in the database should keep a unique tie-breaker (`{ createdAt: -1, _id: 1 }`) to match this contract. The exported `createRecordComparator` / `createEventComparator` give the same comparison for in-memory merges.

## Operational edge cases and recovery

- **Duplicate ids** in a list: run `verifyOrdering(list, { kind })`; it returns `{ ok, outOfOrder, duplicateIds }`. De-duplicate at the source.
- **Records without timestamps**: they sort last. Backfill the field if they should appear in time order.
- **Unexpected order after a deploy**: the comparator is pure and stateless, so there is nothing to repair or reindex. Re-run the request.
- **New statuses**: add them to `STATUS_PRECEDENCE` / `EVENT_STATUS_RANK` (additive), or pass `statusPrecedence` / `statusRank` per call. Until then they rank after known statuses, in a stable order.

## Compatibility and rollback

All existing exports (`STATUS_PRECEDENCE`, `sortRecords`, `paginateRecords`) keep their signatures and ordering for well-formed data. Two intentional behavior changes for edge data:

1. Records with a missing/invalid timestamp now sort last in **oldest-first** lists too (previously they sorted first, as epoch 0). Newest-first lists are unaffected.
2. Status lookup is case/whitespace-insensitive and ignores inherited keys; `"Published"` now ranks as `published` rather than unknown.

Rollback: revert the commit. No data, indexes or API shapes changed. The one call-site change, ordering in `getPartialFailures`, only adds an order where there was none.
