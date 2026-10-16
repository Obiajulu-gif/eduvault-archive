/**
 * Operator-safe backfill runner.
 *
 * A generic driver for one-off data-repair/backfill jobs that:
 *
 *   - **dry-runs by default**: computes and reports the diff every record
 *     would receive without writing anything, so an operator can review the
 *     blast radius before committing to `--execute`.
 *   - **checkpoints progress**: persists the last successfully processed
 *     `_id` to a JSON file after every batch, so a killed/interrupted job
 *     resumes where it left off instead of re-scanning (or re-writing)
 *     records it already handled.
 *   - **never throws out of a single record failure**: a record that fails
 *     to compute or write is counted and logged, the checkpoint is still
 *     advanced past it (it is not retried forever), and the run continues.
 *
 * This module has no MongoDB import of its own -- it is driven entirely by
 * the `collection` the caller passes in, so it can be exercised with an
 * in-memory fake in tests without a real database.
 *
 * Usage sketch (see scripts/migrations/backfill-preview-images-v2.mjs for a
 * complete example):
 *
 *   await runBackfill({
 *     collection: db.collection('materials'),
 *     checkpointPath: '.backfill-checkpoints/preview-images.json',
 *     query: { previewImages: { $exists: false } },
 *     computeUpdate: (doc) => ({ previewImages: [] }),
 *     execute: args.includes('--execute'),
 *   });
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Loads a checkpoint `{ lastId, processed, failed }` from disk, or returns
 * a fresh one if the file doesn't exist or is corrupt. A corrupt checkpoint
 * file must never crash the run -- the safe fallback is "start from the
 * beginning", not "refuse to run".
 */
export function loadCheckpoint(checkpointPath) {
  if (!checkpointPath || !existsSync(checkpointPath)) {
    return { lastId: null, processed: 0, skipped: 0, failed: 0, failedIds: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    return {
      lastId: raw.lastId ?? null,
      processed: raw.processed ?? 0,
      skipped: raw.skipped ?? 0,
      failed: raw.failed ?? 0,
      failedIds: Array.isArray(raw.failedIds) ? raw.failedIds : [],
    };
  } catch {
    return { lastId: null, processed: 0, skipped: 0, failed: 0, failedIds: [] };
  }
}

export function saveCheckpoint(checkpointPath, checkpoint) {
  if (!checkpointPath) return;
  mkdirSync(dirname(checkpointPath), { recursive: true });
  writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
}

/**
 * Builds the resume filter: everything strictly after `lastId` in natural
 * `_id` order. Mongo ObjectIds and UUID-string ids both sort consistently
 * under `$gt`, which is what makes resuming-by-last-id safe here -- it is
 * not safe for fields that can be mutated between runs.
 */
function withResumeFilter(query, lastId) {
  if (lastId == null) return query;
  return { $and: [query, { _id: { $gt: lastId } }] };
}

/**
 * Runs one backfill pass.
 *
 * @param {object} opts
 * @param {object} opts.collection - a MongoDB-collection-shaped object
 *   exposing `find(query).sort({_id:1}).limit(n)` (as an async iterable)
 *   and `updateOne(filter, update)`.
 * @param {object} opts.query - base filter selecting candidate records.
 * @param {(doc: object) => (object|null)} opts.computeUpdate - given a
 *   document, returns the `$set` patch to apply, or `null`/`undefined` to
 *   skip the record (e.g. it turns out to already be correct).
 * @param {string} [opts.checkpointPath] - where to persist/resume progress.
 *   Omit to run a one-shot pass with no resumability.
 * @param {boolean} [opts.execute=false] - if false (the default), no writes
 *   happen; every computed diff is still reported.
 * @param {number} [opts.batchSize=200] - documents per checkpoint flush.
 * @param {(line: string) => void} [opts.log] - defaults to console.log.
 * @returns {Promise<{processed:number, updated:number, skipped:number,
 *   failed:number, diffs: Array<{id:*, patch:object}>}>}
 */
export async function runBackfill({
  collection,
  query,
  computeUpdate,
  checkpointPath = null,
  execute = false,
  batchSize = 200,
  log = (line) => console.log(line),
}) {
  const checkpoint = loadCheckpoint(checkpointPath);
  if (checkpoint.lastId != null) {
    log(`[backfill] Resuming after _id=${checkpoint.lastId} (already processed: ${checkpoint.processed}).`);
  }

  const result = {
    processed: checkpoint.processed,
    updated: 0,
    skipped: checkpoint.skipped,
    failed: checkpoint.failed,
    diffs: [],
  };

  let lastId = checkpoint.lastId;
  let batchCount = 0;

  // The resume filter is recomputed every batch so a checkpoint flush mid-scan
  // never has to hold a live cursor across a crash.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const filter = withResumeFilter(query, lastId);
    const cursor = collection.find(filter).sort({ _id: 1 }).limit(batchSize);
    const docs = [];
    for await (const doc of cursor) docs.push(doc);
    if (docs.length === 0) break;

    for (const doc of docs) {
      lastId = doc._id;
      result.processed += 1;

      let patch;
      try {
        patch = computeUpdate(doc);
      } catch (err) {
        result.failed += 1;
        checkpoint.failedIds.push(String(doc._id));
        log(`[backfill] FAILED computing update for _id=${doc._id}: ${err.message}`);
        continue;
      }

      if (!patch || Object.keys(patch).length === 0) {
        result.skipped += 1;
        continue;
      }

      result.diffs.push({ id: doc._id, patch });

      if (execute) {
        try {
          await collection.updateOne({ _id: doc._id }, { $set: patch });
          result.updated += 1;
        } catch (err) {
          result.failed += 1;
          checkpoint.failedIds.push(String(doc._id));
          log(`[backfill] FAILED writing update for _id=${doc._id}: ${err.message}`);
        }
      } else {
        result.updated += 1; // "would update" count in dry-run mode
      }
    }

    checkpoint.lastId = lastId;
    checkpoint.processed = result.processed;
    checkpoint.skipped = result.skipped;
    checkpoint.failed = result.failed;
    saveCheckpoint(checkpointPath, checkpoint);

    batchCount += 1;
    log(
      `[backfill] Batch ${batchCount}: processed=${result.processed} ` +
        `updated=${result.updated} skipped=${result.skipped} failed=${result.failed}` +
        (execute ? '' : ' (dry-run, no writes)'),
    );
  }

  return result;
}

/**
 * Pretty-prints the diff a dry-run computed, for operator review before
 * re-running with `--execute`.
 */
export function formatDiffReport(diffs, { maxLines = 50 } = {}) {
  const lines = diffs
    .slice(0, maxLines)
    .map((d) => `  _id=${d.id}: ${JSON.stringify(d.patch)}`);
  const suffix = diffs.length > maxLines ? `\n  ... and ${diffs.length - maxLines} more` : '';
  return `${diffs.length} record(s) would change:\n${lines.join('\n')}${suffix}`;
}
