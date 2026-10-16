#!/usr/bin/env node

// Background Worker CLI & Daemon Runner (#789)
// Continuously polls and processes background jobs with retry handling and dead-letter queueing.

import { getDb } from '../src/lib/mongodb.js';
import {
  processNextJob,
  reprocessDeadLetters,
  listJobs,
} from '../src/lib/workers/backgroundWorker.js';

const args = process.argv.slice(2);
const runOnce = args.includes('--once');
const runReprocess = args.includes('--reprocess-dead-letters');
const runStatus = args.includes('--status');

const pollIntervalArg = args.find((a) => a.startsWith('--poll-interval-ms='));
const pollIntervalMs = pollIntervalArg
  ? Math.max(100, Number(pollIntervalArg.split('=')[1]))
  : 1000;

const workerIdArg = args.find((a) => a.startsWith('--worker-id='));
const workerId = workerIdArg
  ? workerIdArg.split('=')[1]
  : `worker-${process.pid}-${Date.now().toString(36)}`;

const db = await getDb();

if (runStatus) {
  const { jobs: pending, total: pendingTotal } = await listJobs({ status: 'pending', limit: 5, db });
  const { jobs: running, total: runningTotal } = await listJobs({ status: 'running', limit: 5, db });
  const { jobs: deadLetter, total: deadLetterTotal } = await listJobs({ status: 'dead_letter', limit: 5, db });

  console.log(JSON.stringify({
    event: 'background_worker_status',
    counts: {
      pending: pendingTotal,
      running: runningTotal,
      deadLetter: deadLetterTotal,
    },
    samplePending: pending.map((j) => ({ jobId: j.jobId, name: j.name, scheduledFor: j.scheduledFor })),
    sampleDeadLetters: deadLetter.map((j) => ({ jobId: j.jobId, name: j.name, error: j.error?.message })),
  }, null, 2));

  process.exit(0);
}

if (runReprocess) {
  console.log(`[Worker ${workerId}] Reprocessing dead-letter jobs...`);
  const result = await reprocessDeadLetters({ db });
  console.log(JSON.stringify({ event: 'dead_letters_reprocessed', ...result }));
  process.exit(0);
}

console.log(`[Worker ${workerId}] Starting background worker (mode: ${runOnce ? 'single-run' : `continuous, interval: ${pollIntervalMs}ms`})...`);

let isShuttingDown = false;

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Worker ${workerId}] Shutting down gracefully...`);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function runBatch() {
  let processedCount = 0;
  let hasMore = true;

  while (hasMore && !isShuttingDown) {
    const outcome = await processNextJob({ workerId, db });
    if (!outcome.processed) {
      hasMore = false;
    } else {
      processedCount++;
      console.log(JSON.stringify({
        event: 'job_processed',
        workerId,
        jobId: outcome.jobId,
        name: outcome.name,
        success: outcome.success,
        error: outcome.error ? outcome.error.message : null,
      }));
    }
  }

  return processedCount;
}

if (runOnce) {
  const totalProcessed = await runBatch();
  console.log(`[Worker ${workerId}] Single-run complete. Processed ${totalProcessed} jobs.`);
  process.exit(0);
}

// Continuous polling loop
while (!isShuttingDown) {
  try {
    await runBatch();
  } catch (err) {
    console.error(`[Worker ${workerId}] Polling cycle error:`, err);
  }

  await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
}
