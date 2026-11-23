/**
 * Resumable orphan-repair command with checkpoints (issue #1121).
 *
 * Orphaned records are materials/entitlements that have lost their parent
 * relationship (e.g. a material whose creator account was deleted, or an
 * entitlement referencing a non-existent purchase).
 *
 * This module provides:
 * - `createOrphanRepairJob` — builds a repair job from a list of orphan IDs
 *   and a repair function. The job processes records in batches, persists a
 *   checkpoint after each batch, and can be resumed after a crash or restart.
 * - Checkpoint persistence through a pluggable `CheckpointStore` interface so
 *   the same logic works in tests (in-memory) and production (file/DB).
 * - Telemetry on each batch processed, skipped, and failed.
 */

import { recordMetric as _recordMetric, ACTOR_TYPES as _AT, TELEMETRY_RESULT as _TR }
  from "../monitoring/telemetry.js";

export const REPAIR_STATUS = Object.freeze({
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const DEFAULT_BATCH_SIZE = 50;

/**
 * In-memory checkpoint store. Implements the same interface as a persistent
 * store so tests do not need file I/O.
 */
export class MemoryCheckpointStore {
  #data = new Map();

  async save(jobId, checkpoint) {
    this.#data.set(jobId, { ...checkpoint, savedAt: new Date().toISOString() });
  }

  async load(jobId) {
    return this.#data.get(jobId) ?? null;
  }

  async clear(jobId) {
    this.#data.delete(jobId);
  }
}

/**
 * Create a resumable orphan-repair job.
 *
 * @param {object} opts
 * @param {string} opts.jobId - Stable identifier for checkpoint storage.
 * @param {string[]} opts.orphanIds - Full list of IDs to repair.
 * @param {(id: string) => Promise<{ok: boolean, error?: string}>} opts.repairFn
 *   - Called once per orphan. Must be idempotent (safe to retry).
 * @param {object} opts.checkpointStore - Object with save(jobId, cp), load(jobId), clear(jobId).
 * @param {number} [opts.batchSize]
 * @param {(progress: object) => void} [opts.onProgress] - Progress callback.
 * @returns {object} - Repair job instance with run() and cancel() methods.
 */
export function createOrphanRepairJob({
  jobId,
  orphanIds,
  repairFn,
  checkpointStore,
  batchSize = DEFAULT_BATCH_SIZE,
  onProgress,
} = {}) {
  if (!jobId) throw new TypeError("orphan repair job requires a jobId");
  if (!Array.isArray(orphanIds)) throw new TypeError("orphanIds must be an array");
  if (typeof repairFn !== "function") throw new TypeError("repairFn must be a function");
  if (!checkpointStore || typeof checkpointStore.save !== "function") {
    throw new TypeError("checkpointStore must implement save/load/clear");
  }

  let cancelled = false;

  /**
   * Resume from a saved checkpoint or start from the beginning.
   * Returns a summary of the run.
   */
  async function run() {
    // Load an existing checkpoint so we resume where we left off.
    const cp = await checkpointStore.load(jobId);
    const startIndex = cp?.nextIndex ?? 0;
    const totals = {
      processed: cp?.processed ?? 0,
      skipped: cp?.skipped ?? 0,
      failed: cp?.failed ?? 0,
      errors: cp?.errors ?? [],
    };

    if (startIndex >= orphanIds.length) {
      return {
        jobId,
        status: REPAIR_STATUS.COMPLETED,
        ...totals,
        total: orphanIds.length,
        resumed: Boolean(cp),
      };
    }

    _recordMetric("orphan_repair.started", { jobId, startIndex, total: orphanIds.length }, {
      operation: "orphan_repair.run",
      actorType: _AT.SYSTEM,
      result: _TR.SUCCESS,
    });

    let i = startIndex;
    let status = REPAIR_STATUS.IN_PROGRESS;

    try {
      while (i < orphanIds.length) {
        if (cancelled) {
          status = REPAIR_STATUS.CANCELLED;
          break;
        }

        const batchEnd = Math.min(i + batchSize, orphanIds.length);
        const batch = orphanIds.slice(i, batchEnd);

        for (const id of batch) {
          if (cancelled) break;
          try {
            const outcome = await repairFn(id);
            if (outcome?.ok === false) {
              totals.skipped += 1;
            } else {
              totals.processed += 1;
            }
          } catch (err) {
            totals.failed += 1;
            totals.errors.push({ id, message: err?.message ?? String(err) });
          }
        }

        i = batchEnd;

        // Persist a checkpoint after every batch so a restart picks up here.
        await checkpointStore.save(jobId, {
          nextIndex: i,
          processed: totals.processed,
          skipped: totals.skipped,
          failed: totals.failed,
          errors: totals.errors,
        });

        _recordMetric("orphan_repair.batch_complete", {
          jobId, batchEnd: i, total: orphanIds.length,
        }, {
          operation: "orphan_repair.batch",
          actorType: _AT.SYSTEM,
          result: _TR.SUCCESS,
        });

        if (typeof onProgress === "function") {
          try {
            onProgress({
              jobId,
              nextIndex: i,
              total: orphanIds.length,
              ...totals,
            });
          } catch { /* ignore progress errors */ }
        }
      }

      if (status === REPAIR_STATUS.IN_PROGRESS) {
        status = i >= orphanIds.length ? REPAIR_STATUS.COMPLETED : REPAIR_STATUS.IN_PROGRESS;
      }

      if (status === REPAIR_STATUS.COMPLETED) {
        await checkpointStore.clear(jobId);
      }
    } catch (fatalErr) {
      status = REPAIR_STATUS.FAILED;
      _recordMetric("orphan_repair.fatal_error", { jobId, error: fatalErr?.message }, {
        operation: "orphan_repair.run",
        actorType: _AT.SYSTEM,
        result: _TR.FAILURE,
      });
      throw fatalErr;
    }

    _recordMetric("orphan_repair.finished", { jobId, status, ...totals }, {
      operation: "orphan_repair.run",
      actorType: _AT.SYSTEM,
      result: status === REPAIR_STATUS.COMPLETED ? _TR.SUCCESS : _TR.FAILURE,
    });

    return {
      jobId,
      status,
      ...totals,
      total: orphanIds.length,
      resumed: Boolean(cp),
    };
  }

  function cancel() {
    cancelled = true;
  }

  return { run, cancel };
}
