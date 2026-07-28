import { getDb } from "../src/lib/mongodb.js";
import { createJsonRpcEventSource, runIndexerBatch } from "../src/lib/indexer/stellarIndexer.js";
import { runRecovery } from "../src/lib/indexer/recovery.js";
import { getLedgerBySequence } from "../src/lib/stellar/horizonClient.js";

const rpcUrl = process.env.NEXT_PUBLIC_STELLAR_RPC_URL;
const contractIds = [
  process.env.NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID,
  process.env.NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID,
].filter(Boolean);
const contractId =
  contractIds.length > 0 ? contractIds : process.env.NEXT_PUBLIC_SOROBAN_CONTRACT_ID;

const runMode = process.argv[2] || 'index';

if (!rpcUrl) {
  throw new Error("NEXT_PUBLIC_STELLAR_RPC_URL is required to run the Stellar indexer");
}

const db = await getDb();

if (runMode === 'recover') {
  // Recovery mode: audit Horizon against the database and re-index missing transactions.
  const accountId = process.env.STELLAR_ADMIN_PUBLIC_KEY || process.argv[3];
  if (!accountId) {
    throw new Error("STELLAR_ADMIN_PUBLIC_KEY or a positional argument is required for recovery mode");
  }

  const limit = Number(process.env.RECOVERY_LOOKBACK_LEDGERS || 200);
  const result = await runRecovery({ db, accountId, limit });

  console.log(JSON.stringify({ event: "stellar_recovery_complete", ...result }));
} else {
  // Default: run a normal indexer batch.
  const result = await runIndexerBatch({
    db,
    eventSource: createJsonRpcEventSource({ rpcUrl, contractId }),
    // Enables ledger-hash-based fork detection and checkpointing (#469).
    getLedgerHash: getLedgerBySequence,
  });

  console.log(JSON.stringify({ event: "stellar_indexer_batch_complete", ...result }));
}
