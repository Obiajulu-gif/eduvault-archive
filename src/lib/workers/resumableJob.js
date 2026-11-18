import crypto from "node:crypto";

export const RESUMABLE_STATES = Object.freeze(["queued", "running", "paused", "completed", "dead_letter"]);

export class ResumableJobAuthorizationError extends Error {
  constructor(message = "Authorized operator is required for dead-letter recovery", { code = "AUTH_FORBIDDEN", status = 403 } = {}) {
    super(message);
    this.name = "ResumableJobAuthorizationError";
    this.code = code;
    this.status = status;
    this.retryable = false;
  }
}

/** Small durable-friendly state machine for jobs that process bounded batches. */
export function createResumableJob({ name, payload = {}, checkpoint = null, maxAttempts = 3 } = {}) {
  if (!name) throw new TypeError("name is required");
  return {
    jobId: crypto.randomUUID(), name, payload, checkpoint, status: "queued",
    attemptCount: 0, maxAttempts, lastError: null, errorHistory: [], recoveryHistory: [], updatedAt: new Date()
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
  const retryable = error?.retryable !== false;
  const lastError = {
    code: error?.code || "INTERNAL",
    message: error?.message || String(error),
    retryable,
    at: now,
  };
  const exhausted = !retryable || job.attemptCount >= job.maxAttempts;
  const errorHistory = [...(job.errorHistory || []), lastError].slice(-20);
  return {
    ...job,
    status: exhausted ? "dead_letter" : "paused",
    lastError,
    errorHistory,
    updatedAt: now,
  };
}

/**
 * Executes a resumable job in bounded batches, persisting checkpoints after each
 * batch and transitioning to `paused` or `dead_letter` on failure.
 */
export async function runResumableJob(job, handler, { maxBatches = Infinity, onRollback = null, now = () => new Date() } = {}) {
  if (typeof handler !== "function") throw new TypeError("handler must be a function");
  if (job.status === "completed" || job.status === "dead_letter") {
    throw new Error(`Cannot run job in terminal/dead-letter state: ${job.status}`);
  }

  let current = claimResumableJob(job, now());
  let batches = 0;

  try {
    while (batches < maxBatches) {
      batches += 1;
      const step = await handler(current, { checkpoint: current.checkpoint });
      if (step && Object.hasOwn(step, "checkpoint") && step.checkpoint !== undefined) {
        current = checkpointResumableJob(current, step.checkpoint, now());
      }
      if (!step || step.done !== false) {
        return completeResumableJob(current, step?.result ?? null, now());
      }
    }
    return pauseResumableJob(current, now());
  } catch (error) {
    if (typeof onRollback === "function") {
      await onRollback(current, error);
    }
    return failResumableJob(current, error, now());
  }
}

/**
 * Operator-authorized recovery for a dead-lettered resumable job.
 * Preserves the last durable checkpoint so work resumes without replaying
 * already-checkpointed batches.
 */
export async function recoverDeadLetterJob(
  job,
  { actor = null, authorize = null, reason = "operator_recovery", resetAttempts = true, now = new Date() } = {},
) {
  if (!actor) {
    throw new ResumableJobAuthorizationError("Authentication required for dead-letter recovery", {
      code: "AUTH_UNAUTHENTICATED",
      status: 401,
    });
  }
  const authorized = typeof authorize === "function"
    ? (await authorize(actor, "dead-letter:recover")) === true
    : actor.role === "admin" || actor.role === "operator";
  if (!authorized) {
    throw new ResumableJobAuthorizationError("Operator authorization required for dead-letter recovery", {
      code: "AUTH_FORBIDDEN",
      status: 403,
    });
  }
  if (job.status !== "dead_letter") {
    throw new Error(`Only dead_letter jobs can be recovered (current status: ${job.status})`);
  }

  const recoveryEntry = {
    recoveredBy: actor.id ?? actor.role ?? "operator",
    reason,
    recoveredAt: now,
    previousAttemptCount: job.attemptCount,
    checkpoint: job.checkpoint,
  };

  return {
    ...job,
    status: "queued",
    attemptCount: resetAttempts ? 0 : job.attemptCount,
    recoveryHistory: [...(job.recoveryHistory || []), recoveryEntry],
    updatedAt: now,
  };
}

