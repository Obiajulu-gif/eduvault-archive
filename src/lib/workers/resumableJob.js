import crypto from "node:crypto";

export const RESUMABLE_STATES = Object.freeze(["queued", "running", "paused", "completed", "dead_letter"]);

/** Small durable-friendly state machine for jobs that process bounded batches. */
export function createResumableJob({ name, payload = {}, checkpoint = null, maxAttempts = 3 } = {}) {
  if (!name) throw new TypeError("name is required");
  return {
    jobId: crypto.randomUUID(), name, payload, checkpoint, status: "queued",
    attemptCount: 0, maxAttempts, lastError: null, updatedAt: new Date()
  };
}

export function claimResumableJob(job, now = new Date()) {
  if (job.status !== "queued" && job.status !== "paused") return job;
  return { ...job, status: "running", attemptCount: job.attemptCount + 1, updatedAt: now };
}

export function checkpointResumableJob(job, checkpoint, now = new Date()) {
  if (job.status !== "running") throw new Error("Only running jobs can checkpoint");
  return { ...job, checkpoint, updatedAt: now };
}

export function pauseResumableJob(job, now = new Date()) {
  if (job.status !== "running") return job;
  return { ...job, status: "paused", updatedAt: now };
}

export function completeResumableJob(job, result = null, now = new Date()) {
  if (job.status !== "running") return job;
  return { ...job, status: "completed", result, updatedAt: now };
}

export function failResumableJob(job, error, now = new Date()) {
  const lastError = { code: error?.code || "INTERNAL", message: error?.message || String(error) };
  return { ...job, status: job.attemptCount >= job.maxAttempts ? "dead_letter" : "paused", lastError, updatedAt: now };
}

