import { describe, expect, it, vi } from "vitest";
import {
  ResumableJobAuthorizationError,
  claimResumableJob,
  completeResumableJob,
  createResumableJob,
  failResumableJob,
  checkpointResumableJob,
  recoverDeadLetterJob,
  runResumableJob,
} from "./resumableJob.js";

describe("resumable background jobs (#1075)", () => {
  it("persists a checkpoint and resumes from it after a transient failure", () => {
    let job = createResumableJob({ name: "export", checkpoint: { cursor: 0 } });
    job = claimResumableJob(job);
    job = checkpointResumableJob(job, { cursor: 25 });
    job = failResumableJob(job, Object.assign(new Error("temporary"), { code: "SERVICE_UNAVAILABLE" }));
    expect(job.status).toBe("paused");
    expect(job.checkpoint).toEqual({ cursor: 25 });
    job = claimResumableJob(job);
    expect(completeResumableJob(job, { processed: 50 }).status).toBe("completed");
  });

  it("moves exhausted attempts or non-retryable failures to the dead-letter state", () => {
    let job = createResumableJob({ name: "index", maxAttempts: 1 });
    job = claimResumableJob(job);
    expect(failResumableJob(job, new Error("permanent")).status).toBe("dead_letter");

    let nonRetryable = createResumableJob({ name: "index", maxAttempts: 5 });
    nonRetryable = claimResumableJob(nonRetryable);
    nonRetryable = failResumableJob(
      nonRetryable,
      Object.assign(new Error("invalid payload"), { code: "VALIDATION_FAILED", retryable: false }),
    );
    expect(nonRetryable.status).toBe("dead_letter");
  });

  it("runs bounded batches, invokes rollback on failure, and recovers dead-letter jobs with operator auth", async () => {
    const rollback = vi.fn();
    let job = createResumableJob({ name: "bulk-export", checkpoint: { offset: 0 }, maxAttempts: 2 });

    // Batch 1 yields at maxBatches: 1
    job = await runResumableJob(
      job,
      async ({ checkpoint }) => ({ done: false, checkpoint: { offset: checkpoint.offset + 10 } }),
      { maxBatches: 1 },
    );
    expect(job.status).toBe("paused");
    expect(job.checkpoint).toEqual({ offset: 10 });

    // Batch 2 fails permanently (exhausts maxAttempts: 2) -> dead_letter
    job = await runResumableJob(
      job,
      async () => {
        throw Object.assign(new Error("storage down"), { code: "STORAGE_UNAVAILABLE" });
      },
      { onRollback: rollback },
    );
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(job.status).toBe("dead_letter");
    expect(job.checkpoint).toEqual({ offset: 10 });

    // Unauthorized recovery is rejected
    await expect(recoverDeadLetterJob(job, { actor: null }))
      .rejects.toMatchObject({ status: 401, code: "AUTH_UNAUTHENTICATED" });
    await expect(recoverDeadLetterJob(job, { actor: { id: "u1", role: "learner" } }))
      .rejects.toBeInstanceOf(ResumableJobAuthorizationError);

    // Authorized operator recovers dead-letter job preserving checkpoint
    job = await recoverDeadLetterJob(job, {
      actor: { id: "op-1", role: "operator" },
      reason: "storage_restored",
    });
    expect(job.status).toBe("queued");
    expect(job.attemptCount).toBe(0);
    expect(job.checkpoint).toEqual({ offset: 10 });
    expect(job.recoveryHistory).toHaveLength(1);

    // Resumes from checkpoint { offset: 10 } and completes
    job = await runResumableJob(job, async ({ checkpoint }) => ({
      done: true,
      checkpoint: { offset: checkpoint.offset + 10 },
      result: { totalProcessed: checkpoint.offset + 10 },
    }));
    expect(job.status).toBe("completed");
    expect(job.result).toEqual({ totalProcessed: 20 });
  });
});

