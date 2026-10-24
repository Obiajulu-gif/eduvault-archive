import { describe, expect, it } from "vitest";
import { claimResumableJob, completeResumableJob, createResumableJob, failResumableJob, checkpointResumableJob } from "./resumableJob.js";

describe("resumable background jobs", () => {
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

  it("moves exhausted attempts to the dead-letter state", () => {
    let job = createResumableJob({ name: "index", maxAttempts: 1 });
    job = claimResumableJob(job);
    expect(failResumableJob(job, new Error("permanent")).status).toBe("dead_letter");
  });
});

