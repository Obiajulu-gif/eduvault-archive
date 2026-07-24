import { getDb } from "../src/lib/mongodb.js";
import { repairPartialIndexedEvents } from "../src/lib/indexer/stellarIndexer.js";

const limit = Number(process.env.INDEXER_REPAIR_LIMIT || process.argv[2] || 100);
if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
  throw new Error("repair limit must be an integer between 1 and 10000");
}

const db = await getDb();
const result = await repairPartialIndexedEvents(db, { limit });

console.log(JSON.stringify({ event: "indexer_projection_repair_complete", ...result }));
if (result.failed.length > 0) process.exitCode = 1;
