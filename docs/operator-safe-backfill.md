# Operator-safe backfill tool

`scripts/lib/backfill-runner.mjs` is the shared driver for one-off
data-repair/backfill jobs. It exists so individual backfill scripts don't
each reinvent (or forget) the same safety properties:

- **Dry-run by default.** `runBackfill` never writes unless the caller
  passes `execute: true`. Every concrete script in `scripts/migrations/`
  built on this runner should surface that as a `--execute` CLI flag and
  default to dry-run, so an operator's first invocation is always a
  no-op report.
- **Resumable via checkpoint file.** After every batch, the last
  processed `_id` and running counters are written to `checkpointPath`.
  If the process is killed (deploy, OOM, manual Ctrl-C), re-running the
  same command resumes with `_id > lastId` instead of rescanning —
  important for backfills over collections large enough that a full
  rescan is itself costly. A corrupt or missing checkpoint file is treated
  as "start from the beginning", never as a fatal error.
- **Per-record failure isolation.** A record whose `computeUpdate` throws,
  or whose write fails, is counted in `failed` and logged with its `_id`;
  the run continues past it rather than aborting the whole batch.

## Writing a new backfill with it

```js
import { runBackfill, formatDiffReport } from '../lib/backfill-runner.mjs';

const result = await runBackfill({
  collection: db.collection('materials'),
  query: { previewImages: { $exists: false } },
  computeUpdate: (doc) => ({ previewImages: [] }),
  checkpointPath: '.backfill-checkpoints/preview-images.json',
  execute: args.includes('--execute'),
});

console.log(formatDiffReport(result.diffs));
```

See `scripts/migrations/backfill-preview-images-v2.mjs` for a full runnable
example, including checkpoint cleanup on a fully-successful execute run so a
later unrelated invocation doesn't think it's resuming a stale job.

## Operational notes

- **Resuming assumes `_id` ordering is stable and the base `query` doesn't
  change between runs.** If the query itself changes (e.g. you widen the
  filter), delete the checkpoint file or pass `--reset-checkpoint` — the
  `_id`-based resume cursor from a different query is not meaningful.
- **Dry-run output is the operator's change-review step.** `formatDiffReport`
  truncates to the first 50 records by default; review the summary counts
  (`processed`/`updated`/`skipped`/`failed`) for the full picture before
  re-running with `--execute`.
- **Rollback**: this runner only ever applies `$set` patches computed by the
  caller's `computeUpdate` — it has no generic rollback, because "undo this
  patch" requires knowing the prior value, which varies per migration. A
  migration that needs rollback should capture the previous value in its own
  patch (e.g. `{ previewImages: [], previewImagesBackfilledFrom: null }`) so
  a separate, explicit rollback script can target exactly the records this
  tool touched.
- **Failure recovery**: `failedIds` accumulates in the checkpoint file across
  runs. Re-running does not retry failed records automatically (they are
  past `lastId` once encountered) — inspect `failedIds` and handle them with
  a targeted follow-up query if the failure was transient.
