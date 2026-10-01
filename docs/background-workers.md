# Background Worker Framework (#789)

EduVault utilizes a resilient, observable background worker framework for long-running, asynchronous, and retryable maintenance and marketplace tasks.

## Overview

Moving heavy or delayed operations out of HTTP request handlers into background workers provides:
- **Fast HTTP response times**: Handlers acknowledge and return a `jobId` immediately (`HTTP 202 Accepted`).
- **Resilience against timeouts**: Transient failures (network issues, rate limits, lock contention) automatically retry with exponential backoff and jitter.
- **Mutual exclusion**: Distributed leases (`lockedUntil`, `lockedBy`) prevent multiple workers from conflicting on the same job.
- **Idempotency**: Prevent duplicate job submission with `idempotencyKey`.
- **Observability**: Complete attempt history, stack traces, and error context are preserved for diagnostics.
- **Dead-Letter Handling**: Jobs exhausting maximum retries move to `dead_letter` status for manual inspection and replay.

---

## Job Lifecycle and Schema

```
[ Enqueued ] ──> [ Pending (scheduledFor) ]
                       │
                       ▼ (leaseNextJob)
                 [ Running (lockedUntil) ]
                  │                     │
      (Success)   │                     │ (Failure)
                  ▼                     ▼
            [ Completed ]        attempts < maxAttempts ?
                                   │              │
                           (Yes)   ▼              ▼ (No)
                         [ Pending ]         [ Dead Letter ]
                         (backoff retry)      (inspect & retryJob)
```

### Job Document Format (`background_jobs` collection)

| Field | Type | Description |
|---|---|---|
| `jobId` | `string` (UUID) | Unique job identifier |
| `name` | `string` | Registered job type identifier (e.g., `storage:garbage-collection`) |
| `payload` | `object` | Handler-specific input parameters |
| `status` | `string` | `'pending'` \| `'running'` \| `'completed'` \| `'failed'` \| `'dead_letter'` |
| `attemptCount` | `number` | Total number of execution attempts so far |
| `maxAttempts` | `number` | Maximum allowed attempts before transitioning to `dead_letter` (default: 3) |
| `scheduledFor` | `Date` | Timestamp when the job is eligible for execution (supports delayed jobs) |
| `lockedUntil` | `Date \| null` | Distributed lease expiration timestamp |
| `lockedBy` | `string \| null` | Worker instance ID currently holding the lease |
| `idempotencyKey` | `string \| null` | Optional deduplication key |
| `createdAt` | `Date` | Timestamp when enqueued |
| `updatedAt` | `Date` | Timestamp of last state change |
| `completedAt` | `Date \| null` | Timestamp when successfully completed |
| `result` | `any` | Return value from successful job handler execution |
| `error` | `object \| null` | Preserved diagnostic context: `{ message, name, code, stack, failedAt, attempt }` |
| `attempts` | `Array<object>` | Complete audit log of every execution attempt |

---

## Running Workers Locally

### 1. Continuous Polling Mode (Daemon)

Run the background worker daemon polling every second:

```bash
npm run worker:background
```

Optional CLI flags:
```bash
# Custom polling interval (ms)
node scripts/run-background-worker.mjs --poll-interval-ms=2000

# Custom worker identifier
node scripts/run-background-worker.mjs --worker-id=worker-local-dev
```

### 2. Single-Run Mode (Batch / Cron)

Process all currently eligible pending jobs once and exit:

```bash
npm run worker:background:once
```

### 3. Check Worker & Queue Status

Inspect pending, running, and dead-letter job counts from the terminal:

```bash
npm run worker:background:status
```

### 4. Reprocess Dead-Letter Jobs

Re-queue all dead-lettered jobs for execution:

```bash
npm run worker:background:reprocess
```

---

## Migrated Maintenance Operations

Storage maintenance operations have been migrated to the worker framework:
- `storage:garbage-collection`: Dry-run and automated unpinning of orphaned IPFS CIDs
- `storage:verify-pins`: Batch pin health check against pinning providers
- `storage:verify-integrity`: Content integrity and checksum verification
- `storage:repair-pins`: Automatic pin repairs and re-pinning

### API Endpoints (`/api/admin/storage-jobs`)

- **POST `/api/admin/storage-jobs`**: Enqueue maintenance task
  ```json
  {
    "action": "garbage-collection",
    "options": {
      "dryRun": true,
      "limit": 50
    }
  }
  ```
  Returns `HTTP 202 Accepted` with `{ success: true, queued: true, jobId: "...", status: "pending" }`.

- **GET `/api/admin/storage-jobs?jobId=<id>`**: Inspect job details and failure context.
- **GET `/api/admin/storage-jobs?status=jobs`**: List recent jobs.
- **POST `/api/admin/storage-jobs` with `action: "retry-job"`**:
  ```json
  {
    "action": "retry-job",
    "jobId": "..."
  }
  ```

---

## Running Automated Tests

Run the test suite verifying job enqueueing, retry backoff, lease locking, error context preservation, and dead-letter handling:

```bash
npx tsx --test tests/backend/background-worker.test.mjs
```
