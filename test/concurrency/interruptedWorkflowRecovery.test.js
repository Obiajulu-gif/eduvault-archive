// @vitest-environment node
/**
 * Deterministic Recovery Tests for Interrupted Workflows — Issue #1071
 *
 * Verifies that interrupted multi-step workflows (resumable batch jobs,
 * invariant-protected transitions, dead-letter recovery, and permission-aware
 * exports) recover deterministically across identical PRNG seeds without
 * duplicate side-effects or authorization bypasses.
 */

import { describe, it, expect } from "vitest";
import { mulberry32 } from "./harness.js";
import {
  ResumableJobAuthorizationError,
  createResumableJob,
  recoverDeadLetterJob,
  runResumableJob,
} from "@/lib/workers/resumableJob.js";
import {
  PermissionExportError,
  RedactionAction,
  executePermissionAwareExport,
} from "@/lib/export/permissionAwareExport.js";

async function runInterruptedBatchWorkflow(seed, { failAtStep = null, maxAttempts = 4 } = {}) {
  const prng = mulberry32(seed);
  const trace = [];
  const appliedItems = [];
  const rollbacks = [];
  const items = ["item-1", "item-2", "item-3", "item-4", "item-5"];

  let stepCounter = 0;
  let job = createResumableJob({
    name: "deterministic-workflow",
    checkpoint: { index: 0 },
    maxAttempts,
  });

  const handler = async (currentJob, { checkpoint }) => {
    stepCounter += 1;
    const idx = checkpoint.index;
    trace.push({ step: stepCounter, attempt: currentJob.attemptCount, index: idx, rand: prng() });

    if (failAtStep !== null && stepCounter === failAtStep) {
      throw Object.assign(new Error(`injected fault at step ${stepCounter}`), {
        code: "STORAGE_UNAVAILABLE",
        retryable: true,
      });
    }

    if (idx >= items.length) {
      return { done: true, checkpoint: { index: idx }, result: { appliedCount: appliedItems.length } };
    }

    appliedItems.push(items[idx]);
    const nextIndex = idx + 1;
    const done = nextIndex >= items.length;
    return {
      done,
      checkpoint: { index: nextIndex },
      ...(done ? { result: { appliedCount: appliedItems.length } } : {}),
    };
  };

  const onRollback = async (currentJob, err) => {
    rollbacks.push({ attempt: currentJob.attemptCount, index: currentJob.checkpoint?.index, code: err.code });
  };

  while (job.status === "queued" || job.status === "paused") {
    job = await runResumableJob(job, handler, { maxBatches: 1, onRollback });
  }

  return { job, trace, appliedItems, rollbacks };
}

describe("Deterministic Recovery for Interrupted Workflows (#1071)", () => {
  it("reproduces bit-for-bit identical recovery traces and zero duplicate writes under identical seeds", async () => {
    const runA = await runInterruptedBatchWorkflow(4242, { failAtStep: 3 });
    const runB = await runInterruptedBatchWorkflow(4242, { failAtStep: 3 });

    expect(runA.job.status).toBe("completed");
    expect(runA.appliedItems).toEqual(["item-1", "item-2", "item-3", "item-4", "item-5"]);
    expect(runA.rollbacks).toEqual([{ attempt: 3, index: 2, code: "STORAGE_UNAVAILABLE" }]);
    expect(runA.trace).toEqual(runB.trace);
    expect(runA.appliedItems).toEqual(runB.appliedItems);
    expect(runA.job.result).toEqual(runB.job.result);
  });

  it("handles exhausted interruptions -> dead_letter -> authorized operator recovery -> deterministic completion", async () => {
    const exhausted = await runInterruptedBatchWorkflow(99, { failAtStep: 2, maxAttempts: 2 });
    expect(exhausted.job.status).toBe("dead_letter");
    expect(exhausted.job.checkpoint).toEqual({ index: 1 });
    expect(exhausted.appliedItems).toEqual(["item-1"]);

    // Unauthorized recovery must fail without altering job state
    await expect(
      recoverDeadLetterJob(exhausted.job, { actor: { id: "u1", role: "learner" } }),
    ).rejects.toBeInstanceOf(ResumableJobAuthorizationError);
    expect(exhausted.job.status).toBe("dead_letter");

    // Authorized operator recovers from checkpoint { index: 1 }
    let recovered = await recoverDeadLetterJob(exhausted.job, {
      actor: { id: "op-1", role: "admin" },
      reason: "incident_mitigated",
    });
    expect(recovered.status).toBe("queued");
    expect(recovered.checkpoint).toEqual({ index: 1 });

    const resumedItems = [...exhausted.appliedItems];
    const items = ["item-1", "item-2", "item-3", "item-4", "item-5"];
    recovered = await runResumableJob(recovered, async (_job, { checkpoint }) => {
      const idx = checkpoint.index;
      resumedItems.push(items[idx]);
      const nextIndex = idx + 1;
      const done = nextIndex >= items.length;
      return { done, checkpoint: { index: nextIndex }, ...(done ? { result: { count: resumedItems.length } } : {}) };
    });

    expect(recovered.status).toBe("completed");
    expect(resumedItems).toEqual(items);
  });

  it("recovers deterministically when a permission-aware export is interrupted mid-fetch", async () => {
    const runExport = async (seed) => {
      const prng = mulberry32(seed);
      let calls = 0;
      return executePermissionAwareExport({
        actor: { id: "c1", role: "creator" },
        requiredPermission: "creator:analytics:read",
        generatedAt: "2026-11-18T12:00:00.000Z",
        fieldPolicies: { email: RedactionAction.MASK },
        maxRetries: 2,
        fetchRecords: async () => {
          calls += 1;
          const draw = prng();
          if (calls === 1 && draw < 1) {
            throw Object.assign(new Error("interrupted"), { code: "STORAGE_UNAVAILABLE", retryable: true });
          }
          return [{ id: "1", email: "user@edu.org" }];
        },
      });
    };

    const expA = await runExport(777);
    const expB = await runExport(777);
    expect(expA.verification.contentHash).toBe(expB.verification.contentHash);
    expect(expA.verification.attempts).toBe(2);
    expect(expA.records[0].email).toBe("u***r@edu.org");

    // Authorization failure never retries or fetches
    await expect(
      executePermissionAwareExport({
        actor: { id: "u1", role: "learner" },
        requiredPermission: "creator:analytics:read",
        fetchRecords: async () => [],
      }),
    ).rejects.toBeInstanceOf(PermissionExportError);
  });
});
