import { Networks } from "@stellar/stellar-sdk";
import { getDb } from "../src/lib/mongodb.js";
import { createJsonRpcEventSource, runIndexerBatch } from "../src/lib/indexer/stellarIndexer.js";
import { runRecovery } from "../src/lib/indexer/recovery.js";

const rpcUrl = process.env.NEXT_PUBLIC_STELLAR_RPC_URL;
const networkPassphrase =
  (process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "TESTNET") === "PUBLIC"
    ? Networks.PUBLIC
    : Networks.TESTNET;
const contractIds = [
  process.env.NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID,
  process.env.NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID,
].filter(Boolean);
const contractId =
  contractIds.length > 0 ? contractIds : process.env.NEXT_PUBLIC_SOROBAN_CONTRACT_ID;

const runMode = process.argv[2] || "index";

// Poll interval between batches. Stellar closes a ledger roughly every 5s, so
// polling much faster than that mostly buys empty responses and RPC quota burn.
const POLL_INTERVAL_MS = Number(process.env.INDEXER_POLL_INTERVAL_MS || 5000);
const BATCH_LIMIT = Number(process.env.INDEXER_BATCH_LIMIT || 100);
// Backoff bounds for transient RPC/Horizon failures. The indexer is a
// background service: a flaky upstream should slow it down, not kill it.
const BACKOFF_MIN_MS = Number(process.env.INDEXER_BACKOFF_MIN_MS || 1000);
const BACKOFF_MAX_MS = Number(process.env.INDEXER_BACKOFF_MAX_MS || 60000);

if (!rpcUrl) {
  throw new Error("NEXT_PUBLIC_STELLAR_RPC_URL is required to run the Stellar indexer");
}

const db = await getDb();

/** Resolves after `ms`, or immediately once shutdown has been requested. */
function sleep(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function emit(payload) {
  console.log(JSON.stringify(payload));
}

async function runOnce() {
  const result = await runIndexerBatch({
    db,
    eventSource: createJsonRpcEventSource({ rpcUrl, contractId, networkPassphrase }),
    limit: BATCH_LIMIT,
  });
  emit({ event: "stellar_indexer_batch_complete", ...result });
  return result;
}

/**
 * Supervised polling loop.
 *
 * The batch function is already crash-safe: cursor progress lives in
 * `sync_state` and per-event receipts live in `sync_events`, so an abrupt exit
 * costs at most a replay of the in-flight batch. What was missing was anything
 * to keep it running, which is why the docs describing this as a service that
 * you "start" did not match a script that processed one batch and exited.
 */
async function runLoop() {
  const controller = new AbortController();
  const { signal } = controller;
  let shuttingDown = false;

  for (const event of ["SIGINT", "SIGTERM"]) {
    process.on(event, () => {
      if (shuttingDown) {
        // Second signal: operator is insisting. Stop waiting for the in-flight
        // batch and let the process die.
        process.exit(130);
      }
      shuttingDown = true;
      emit({ event: "stellar_indexer_shutdown_requested", signal: event });
      controller.abort();
    });
  }

  emit({
    event: "stellar_indexer_started",
    pollIntervalMs: POLL_INTERVAL_MS,
    batchLimit: BATCH_LIMIT,
    contractIds: Array.isArray(contractId) ? contractId : [contractId].filter(Boolean),
  });

  let consecutiveFailures = 0;

  while (!signal.aborted) {
    try {
      const result = await runOnce();
      consecutiveFailures = 0;

      // A full page means more events are already waiting; poll again
      // immediately instead of sleeping through a known backlog.
      const idleMs = result.drained ? POLL_INTERVAL_MS : 0;
      if (idleMs > 0) await sleep(idleMs, signal);
    } catch (error) {
      consecutiveFailures += 1;
      const backoffMs = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (consecutiveFailures - 1));
      emit({
        event: "stellar_indexer_batch_failed",
        consecutiveFailures,
        backoffMs,
        reason: error?.message || String(error),
      });
      await sleep(backoffMs, signal);
    }
  }

  emit({ event: "stellar_indexer_stopped", consecutiveFailures });
}

if (runMode === "recover") {
  // Recovery mode: audit Horizon against the database and re-index payments
  // that map to a known but unsettled purchase.
  const accountId = process.env.STELLAR_ADMIN_PUBLIC_KEY || process.argv[3];
  if (!accountId) {
    throw new Error("STELLAR_ADMIN_PUBLIC_KEY or a positional argument is required for recovery mode");
  }

  const limit = Number(process.env.RECOVERY_LOOKBACK_LEDGERS || 200);
  const result = await runRecovery({ db, accountId, limit });

  emit({
    event: "stellar_recovery_complete",
    ...result,
    orphaned: result.orphaned.length,
    orphanedTransactions: result.orphaned,
  });
} else if (runMode === "once") {
  // Single batch. Used by cron-style deployments and by the tests.
  await runOnce();
} else {
  await runLoop();
}
