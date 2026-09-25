import { getDb } from "../src/lib/mongodb.js";
import { replayQuarantine } from "../src/lib/publishing/quarantine.js";

const limit = Number(process.env.QUARANTINE_REPLAY_LIMIT || 100);
const db = await getDb();
const results = await replayQuarantine(db, limit);

console.log(JSON.stringify({
  event: "quarantine_replay_complete",
  total: results.length,
  results,
}));
