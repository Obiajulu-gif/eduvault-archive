// Bounded in-process concurrency runner with backpressure (#1118).
// Caps jobs in flight, bounds the pending queue, retries failed jobs with
// backoff, and runs an authorization hook before a job is admitted.

export const BOUNDED_RUNNER_REJECTION = Object.freeze({
  QUEUE_FULL: 'QUEUE_FULL',
  UNAUTHORIZED: 'UNAUTHORIZED',
  CLOSED: 'CLOSED',
});

export class RunnerRejectedError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'RunnerRejectedError';
    this.reason = reason;
    this.status = reason === BOUNDED_RUNNER_REJECTION.UNAUTHORIZED ? 403 : 429;
    this.code = `WORKER_${reason}`;
    this.retryable = reason === BOUNDED_RUNNER_REJECTION.QUEUE_FULL;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createBoundedConcurrencyRunner({
  maxInFlight = 4,
  maxPending = 50,
  maxAttempts = 3,
  retryDelayMs = 100,
  authorize = async () => true,
  now = () => Date.now(),
} = {}) {
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
    throw new TypeError('maxInFlight must be a positive integer');
  }
  if (!Number.isInteger(maxPending) || maxPending < 0) {
    throw new TypeError('maxPending must be a non-negative integer');
  }

  const pending = [];
  let inFlight = 0;
  let closed = false;
  const stats = { admitted: 0, rejected: 0, completed: 0, failed: 0, retried: 0 };

  function pump() {
    while (inFlight < maxInFlight && pending.length > 0) {
      const entry = pending.shift();
      inFlight++;
      execute(entry).finally(() => {
        inFlight--;
        pump();
      });
    }
  }

  async function execute(entry) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await entry.task({ attempt, startedAt: now() });
        stats.completed++;
        entry.resolve(result);
        return;
      } catch (error) {
        if (attempt >= maxAttempts || error?.retryable === false) {
          stats.failed++;
          entry.reject(error);
          return;
        }
        stats.retried++;
        await sleep(retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  function reject(reason, message) {
    stats.rejected++;
    return Promise.reject(new RunnerRejectedError(reason, message));
  }

  return {
    submit({ task, principal = null, name = 'job' } = {}) {
      if (typeof task !== 'function') {
        throw new TypeError('task must be a function');
      }
      if (closed) {
        return reject(BOUNDED_RUNNER_REJECTION.CLOSED, `Runner is closed; rejected ${name}.`);
      }

      return Promise.resolve()
        .then(() => authorize(principal, name))
        .then(
          (allowed) => {
            if (allowed !== true) {
              return reject(BOUNDED_RUNNER_REJECTION.UNAUTHORIZED, `Not authorized to run ${name}.`);
            }
            if (pending.length >= maxPending) {
              return reject(
                BOUNDED_RUNNER_REJECTION.QUEUE_FULL,
                `Worker queue is full (${maxPending} pending); retry later.`,
              );
            }
            stats.admitted++;
            return new Promise((resolve, rejectJob) => {
              pending.push({ task, resolve, reject: rejectJob });
              pump();
            });
          },
          () => reject(BOUNDED_RUNNER_REJECTION.UNAUTHORIZED, `Not authorized to run ${name}.`),
        );
    },

    close() {
      closed = true;
    },

    snapshot() {
      return { inFlight, pending: pending.length, maxInFlight, maxPending, ...stats };
    },
  };
}
