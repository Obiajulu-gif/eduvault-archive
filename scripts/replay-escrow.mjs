import { Networks } from "@stellar/stellar-sdk";
import { getDb } from "../src/lib/mongodb.js";
import { createJsonRpcEventSource } from "../src/lib/indexer/stellarIndexer.js";
import { applyEscrowEvent } from "../src/lib/indexer/escrowIndexer.js";

const rpcUrl = process.env.NEXT_PUBLIC_STELLAR_RPC_URL;
const networkPassphrase =
  (process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "TESTNET") === "PUBLIC"
    ? Networks.PUBLIC
    : Networks.TESTNET;

const contractId = process.env.TRUSTLESS_WORK_CONTRACT_ID_TESTNET || process.env.NEXT_PUBLIC_TRUSTLESS_WORK_CONTRACT_ID;

if (!rpcUrl) {
  throw new Error("NEXT_PUBLIC_STELLAR_RPC_URL is required to run the indexer");
}
if (!contractId) {
  throw new Error("TRUSTLESS_WORK_CONTRACT_ID_TESTNET or NEXT_PUBLIC_TRUSTLESS_WORK_CONTRACT_ID is required to run the escrow indexer");
}

const startLedger = parseInt(process.argv[2], 10);
const limit = parseInt(process.argv[3], 10) || 100;

if (!startLedger || isNaN(startLedger)) {
  console.error("Usage: node scripts/replay-escrow.mjs <startLedger> [limit]");
  process.exit(1);
}

const db = await getDb();
const eventSource = createJsonRpcEventSource({ rpcUrl, contractId, networkPassphrase });

console.log(`Replaying escrow events from ledger ${startLedger} with limit ${limit}`);

try {
  const batch = await eventSource.getEvents({ startLedger, limit });
  const events = batch.events || [];
  
  console.log(`Found ${events.length} events to replay.`);
  
  let applied = 0;
  let skipped = 0;
  
  for (const event of events) {
    const result = await applyEscrowEvent(db, { ...event, source: "escrow" });
    if (result.skipped) skipped += 1;
    else applied += 1;
  }
  
  console.log(`Replay complete. Applied: ${applied}, Skipped: ${skipped}`);
} catch (err) {
  console.error("Replay failed:", err);
}

process.exit(0);
