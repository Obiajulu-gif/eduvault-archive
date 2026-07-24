import { getDb } from "../src/lib/mongodb.js";
import { createJsonRpcEventSource } from "../src/lib/indexer/stellarIndexer.js";
import { backfillLedgerRange } from "../src/lib/indexer/backfill.js";

const args = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, ...value] = item.replace(/^--/, "").split("=");
  return [key, value.length ? value.join("=") : true];
}));
const network = String(args.network || "");
const contractIds = String(args.contracts || "").split(",").filter(Boolean);
const startLedger = Number(args.start);
const endLedger = Number(args.end);
if (!network || !contractIds.length || !Number.isInteger(startLedger) || !Number.isInteger(endLedger)) {
  throw new Error("Usage: --network=TESTNET --contracts=C...,C... --start=123 --end=456 [--repair] [--apply]");
}

const db = await getDb();
const eventSource = createJsonRpcEventSource({ rpcUrl: process.env.STELLAR_RPC_URL || process.env.NEXT_PUBLIC_STELLAR_RPC_URL, contractId: contractIds });
const report = await backfillLedgerRange({
  db, eventSource, network, contractIds, startLedger, endLedger,
  jobId: String(args.job || `${network}:${contractIds.join("+")}:${startLedger}-${endLedger}`),
  repair: Boolean(args.repair), dryRun: !args.apply,
});
console.log(JSON.stringify(report, null, 2));
