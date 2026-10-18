import { inspectJob, listJobs, retryJob, reprocessDeadLetters } from "./backgroundWorker.js";

export class OperatorAuthorizationError extends Error {
  constructor() {
    super("An authorized operator is required for dead-letter operations");
    this.name = "OperatorAuthorizationError";
    this.status = 403;
  }
}

export function createDeadLetterOperator({ db, authorize, audit = async () => {} } = {}) {
  const requireOperator = async (actor, action, details = {}) => {
    if (typeof authorize !== "function" || (await authorize(actor, action)) !== true) throw new OperatorAuthorizationError();
    await audit({ actorId: actor?.id ?? null, action, details, at: new Date() });
  };

  return {
    async inspect(actor, jobId) {
      await requireOperator(actor, "dead-letter:inspect", { jobId });
      return inspectJob(jobId, { db });
    },
    async list(actor, filters = {}) {
      await requireOperator(actor, "dead-letter:list", filters);
      return listJobs({ ...filters, status: filters.status ?? "dead_letter", db });
    },
    async retry(actor, jobId, options = {}) {
      await requireOperator(actor, "dead-letter:retry", { jobId });
      return retryJob(jobId, { ...options, db });
    },
    async retryBatch(actor, options = {}) {
      await requireOperator(actor, "dead-letter:retry-batch", options);
      return reprocessDeadLetters({ ...options, db });
    },
  };
}
