import { getDb } from "../src/lib/mongodb.js";
import { createJsonRpcEventSource, runIndexerBatch } from "../src/lib/indexer/stellarIndexer.js";

const rpcUrl = process.env.NEXT_PUBLIC_STELLAR_RPC_URL;
const contractIds = [
  process.env.NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID,
  process.env.NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID,
].filter(Boolean);
const contractId =
  contractIds.length > 0 ? contractIds : process.env.NEXT_PUBLIC_SOROBAN_CONTRACT_ID;

if (!rpcUrl) {
  throw new Error("NEXT_PUBLIC_STELLAR_RPC_URL is required to run the Stellar indexer");
}

const db = await getDb();
const result = await runIndexerBatch({
  db,
  eventSource: createJsonRpcEventSource({ rpcUrl, contractId }),
});

console.log(JSON.stringify({ event: "stellar_indexer_batch_complete", ...result }));
