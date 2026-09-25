import { getDb } from "../src/lib/mongodb.js";
import { reprocessDeadLetters } from "../src/lib/indexer/stellarIndexer.js";
import { NETWORK_PASSPHRASE } from "../src/lib/config/chain.js";

const db = await getDb();
const result = await reprocessDeadLetters(db, {
  statuses: ["retryable", "failed"],
  limit: 500,
  network: NETWORK_PASSPHRASE, // #630: reprocessed events keep the live network scope
});
console.log(JSON.stringify({ event: "deadletter_reprocess_complete", ...result }));
