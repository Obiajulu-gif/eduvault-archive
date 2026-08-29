# Stellar indexer observability (#469)

The indexer (`src/lib/indexer/stellarIndexer.js`) exposes health metrics via
`getIndexerHealth(db, { source, currentLedger })` and the `GET /api/indexer`
route's `health` field. This document describes what each metric means and
suggested alert thresholds.

## Metrics

| Field | Meaning |
| --- | --- |
| `lastLedger` | Sequence of the last ledger the indexer fully applied all events from. |
| `lastLedgerHash` | That ledger's hash, as last confirmed against the canonical chain. Used for fork detection on the next batch. |
| `lastCheckpointAt` | Timestamp of the last successful checkpoint write. |
| `lag` | `currentLedger - lastLedger`, when the caller supplies `currentLedger` from its own RPC/Horizon client. `null` if not supplied — the indexer does not make an extra network call just to measure this. |
| `deadLetterRetryableCount` | Number of dead-lettered events still eligible for automatic retry. |
| `deadLetterFailedCount` | Number of dead-lettered events classified as poison, or that exhausted `INDEXER_MAX_RETRIES` — these need operator attention (see `scripts/reprocess-deadletter.mjs`), not automatic retry. |
| `deadLetterRetrySum` | Sum of retry attempts across all `retryable` entries — a rising figure faster than entries are resolved indicates a systemic issue (e.g. a downstream dependency outage), not isolated bad events. |
| `lastForkRewindAt` / `lastForkDivergenceLedger` | When a chain reorg was last detected and rewound, and the ledger it diverged at. Should be rare; frequent forks indicate an unstable RPC endpoint or a genuinely unstable chain tip being indexed too eagerly. |

## Suggested alert thresholds

Numeric budgets below are the enforceable defaults from the marketplace
performance budget (#670, see
`docs/tasks/marketplace-performance-audit.md` §10).

- **Lag**: alert if `lag` exceeds **10 ledgers** for more than **one polling
  interval** (budget: typical advance is ≤ 5 ledgers per interval, so 10 is
  the "2× the typical batch-to-batch ledger advance" threshold). A sustained
  high lag means batches aren't keeping up (increase `limit`/polling
  frequency) or the indexer has stalled entirely (check for a stuck
  `retryable` entry via `deadLetterRetryableCount`).
- **Dead-letter depth**: alert if `deadLetterFailedCount` is nonzero for more
  than one polling interval — poison events don't self-resolve and need a
  human to look at `raw`/`lastError` on the dead-letter document.
- **Fork rewinds**: alert on any `lastForkRewindAt` more recent than your last
  check — even though rewinds are handled automatically, an operator should
  confirm the orphaned `materials`/`purchases` records (`syncStatus:
  "orphaned"` / `settlementState: "Orphaned"`) don't need manual follow-up
  (e.g. a refund for a buyer whose purchase was orphaned).

## Gaps and retries

"Gaps" (ledger ranges the indexer never saw at all, as opposed to events it
saw but failed to apply) are covered by the existing recovery path in
`src/lib/indexer/recovery.js` / `scripts/run-stellar-indexer.mjs recover`,
which audits Horizon against the database independently of the cursor-based
`runIndexerBatch` path. "Retries" for events the indexer *did* see but failed
to apply are tracked via the dead-letter collection and
`classifyIndexerError` (transient vs. poison), described above.

## Operator dead-letter tooling (#668)

Operators can inspect and manage failed indexer events with
`scripts/indexer-deadletter.mjs`:

```bash
node scripts/indexer-deadletter.mjs list --status=retryable --limit=20
node scripts/indexer-deadletter.mjs retry <eventId>
node scripts/indexer-deadletter.mjs quarantine <eventId> --reason="Malformed payload"
```

Every retry or quarantine action is written to `indexer_operator_audit`.
Permanent failures must be quarantined with an explicit reason before they are
excluded from automatic retry.

## Known scope limits

- Fork detection only compares the single most-recently-checkpointed ledger's
  hash against the canonical chain (a *shallow* reorg check), not a deeper
  walk back through checkpoint history. See the module doc comment in
  `src/lib/indexer/forkDetection.js` for how to extend this if a deeper check
  becomes necessary.
- A rewind resets the cursor to `null` (full resync from the event source's
  beginning) rather than resuming at a computed intermediate position, since
  Soroban RPC cursors are opaque pagination tokens, not ledger sequences.
