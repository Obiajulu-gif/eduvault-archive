import { Networks } from "@stellar/stellar-sdk";
import { getDb } from "../src/lib/mongodb.js";
import { createJsonRpcEventSource, runIndexerBatch } from "../src/lib/indexer/stellarIndexer.js";
import { applyEscrowEvent } from "../src/lib/indexer/escrowIndexer.js";

const rpcUrl = process.env.NEXT_PUBLIC_STELLAR_RPC_URL;
const networkPassphrase =
  (process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "TESTNET") === "PUBLIC"
    ? Networks.PUBLIC
    : Networks.TESTNET;

const contractId = process.env.TRUSTLESS_WORK_CONTRACT_ID_TESTNET || process.env.NEXT_PUBLIC_TRUSTLESS_WORK_CONTRACT_ID;

const runMode = process.argv[2] || "index";

const POLL_INTERVAL_MS = Number(process.env.INDEXER_POLL_INTERVAL_MS || 5000);
const BATCH_LIMIT = Number(process.env.INDEXER_BATCH_LIMIT || 100);
const BACKOFF_MIN_MS = Number(process.env.INDEXER_BACKOFF_MIN_MS || 1000);
const BACKOFF_MAX_MS = Number(process.env.INDEXER_BACKOFF_MAX_MS || 60000);

if (!rpcUrl) {
  throw new Error("NEXT_PUBLIC_STELLAR_RPC_URL is required to run the indexer");
}
if (!contractId) {
  throw new Error("TRUSTLESS_WORK_CONTRACT_ID_TESTNET or NEXT_PUBLIC_TRUSTLESS_WORK_CONTRACT_ID is required to run the escrow indexer");
}

const db = await getDb();

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }
  });
}

function emit(payload) {
  console.log(JSON.stringify(payload));
}

async function runOnce() {
  const result = await runIndexerBatch({
    db,
    eventSource: createJsonRpcEventSource({ rpcUrl, contractId, networkPassphrase }),
    source: "escrow",
    limit: BATCH_LIMIT,
    applyFn: applyEscrowEvent,
  });
  emit({ event: "escrow_indexer_batch_complete", ...result });
  return result;
}

async function runLoop() {
  const controller = new AbortController();
  const { signal } = controller;
  let shuttingDown = false;

  for (const event of ["SIGINT", "SIGTERM"]) {
    process.on(event, () => {
      if (shuttingDown) {
        process.exit(130);
      }
      shuttingDown = true;
      emit({ event: "escrow_indexer_shutdown_requested", signal: event });
      controller.abort();
    });
  }

  emit({
    event: "escrow_indexer_started",
    pollIntervalMs: POLL_INTERVAL_MS,
    batchLimit: BATCH_LIMIT,
    contractIds: [contractId],
  });

  let consecutiveFailures = 0;

  while (!signal.aborted) {
    try {
      const result = await runOnce();
      consecutiveFailures = 0;

      const idleMs = result.drained ? POLL_INTERVAL_MS : 0;
      if (idleMs > 0) await sleep(idleMs, signal);
    } catch (error) {
      consecutiveFailures += 1;
      const backoffMs = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (consecutiveFailures - 1));
      emit({
        event: "escrow_indexer_batch_failed",
        consecutiveFailures,
        backoffMs,
        reason: error?.message || String(error),
      });
      await sleep(backoffMs, signal);
    }
  }

  emit({ event: "escrow_indexer_stopped", consecutiveFailures });
}

if (runMode === "once") {
  await runOnce();
} else {
  await runLoop();
}
