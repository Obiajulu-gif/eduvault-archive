# Resumable Jobs with Dead-Letter Recovery (#1075)

## Overview
`src/lib/workers/resumableJob.js` provides a durable-friendly state machine (`queued` -> `running` -> `paused` / `completed` / `dead_letter`) for bounded-batch background jobs, paired with `src/lib/workers/deadLetterOperator.js` for persistent MongoDB queue operations.

## Lifecycle & Recovery
1. **Checkpointing**: `runResumableJob(job, handler, { maxBatches, onRollback })` claims the job, saves checkpoints after each batch, and yields to `paused` when `maxBatches` is reached.
2. **Failure & Retry**: Transient errors (`retryable !== false`) transition the job to `paused` while `attemptCount < maxAttempts`, preserving `checkpoint`.
3. **Dead-Lettering & Rollback**: Non-retryable errors (`retryable === false`) or exhausted attempts (`attemptCount >= maxAttempts`) transition the job to `dead_letter` after invoking `onRollback(job, error)` if supplied.
4. **Authorized Dead-Letter Recovery**: `recoverDeadLetterJob(job, { actor, authorize, reason, resetAttempts })` requires an authenticated `admin`/`operator` (or custom `authorize` callback), records an entry in `recoveryHistory`, resets `attemptCount` (by default), and transitions `dead_letter` -> `queued` while preserving the last `checkpoint`.

## Edge Cases & Compatibility
- Attempting to run a `completed` or `dead_letter` job throws immediately instead of mutating state.
- Attempting to recover a non-`dead_letter` job throws without altering state.
- All existing exports (`RESUMABLE_STATES`, `createResumableJob`, `claimResumableJob`, `checkpointResumableJob`, `pauseResumableJob`, `completeResumableJob`, `failResumableJob`) remain backward compatible.
