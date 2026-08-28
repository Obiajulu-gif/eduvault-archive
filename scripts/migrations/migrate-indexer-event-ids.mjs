/**
 * Migration: canonicalise Stellar indexer event ids (#630)
 *
 * Re-derives every `sync_events` and `dead_letter_events` row's identity from
 * its stored raw event using the deterministic scheme in
 * `src/lib/indexer/eventIdentity.js`, rewrites the row's `_id`, and emits a
 * JSON collision report. All logic lives in
 * `src/lib/indexer/eventIdMigration.js` (`migrateEventIds`); this file only
 * wires up Mongo and the CLI.
 *
 * A row becomes one of: unchanged | rewrite | collision | quarantine — see the
 * `migrateEventIds` doc comment.
 *
 * This script never calls `applyIndexedEvent`; it only rewrites `_id`s and
 * moves un-identifiable rows aside, so it cannot itself double-apply anything.
 *
 * Usage:
 *   # Dry run (default) — report only, no writes:
 *   MONGODB_URI=mongodb://... NEXT_PUBLIC_STELLAR_NETWORK=PUBLIC \
 *     node scripts/migrations/migrate-indexer-event-ids.mjs
 *
 *   # Apply:
 *   MONGODB_URI=mongodb://... NEXT_PUBLIC_STELLAR_NETWORK=PUBLIC \
 *     node scripts/migrations/migrate-indexer-event-ids.mjs --apply --out report.json
 *
 * Flags:
 *   --apply                 perform writes (default: dry run)
 *   --collection=<name>     limit to sync_events | dead_letter_events (default: both)
 *   --out=<file>            also write the JSON report to <file>
 *
 * Safe to re-run: after --apply, a second run re-derives the same ids and
 * reports all-unchanged. Exit code is 1 when any collision was found (operator
 * should review), else 0. Rollback is forward-only — see #630 in
 * implementation.md.
 */

import { writeFileSync } from "node:fs";
import { MongoClient } from "mongodb";
import { Networks } from "@stellar/stellar-sdk";
import { migrateEventIds } from "../../src/lib/indexer/eventIdMigration.js";

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "eduvault";

// Mirror src/lib/config/chain.js's NETWORK_PASSPHRASE resolution (that module
// can't be imported here — it pulls in the Next.js-only `@/` alias).
const STELLAR_NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "TESTNET";
const NETWORK_PASSPHRASE = STELLAR_NETWORK === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET;

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const outFile = args.find((a) => a.startsWith("--out="))?.slice("--out=".length) || null;
const onlyCollection = args.find((a) => a.startsWith("--collection="))?.slice("--collection=".length) || null;

if (!MONGODB_URI) {
  console.error("[migrate-indexer-event-ids] ERROR: MONGODB_URI is not set.");
  process.exit(1);
}
if (onlyCollection && !["sync_events", "dead_letter_events"].includes(onlyCollection)) {
  console.error(`[migrate-indexer-event-ids] ERROR: unknown --collection=${onlyCollection}`);
  process.exit(1);
}
if (!process.env.NEXT_PUBLIC_STELLAR_NETWORK) {
  console.warn(
    "[migrate-indexer-event-ids] WARNING: NEXT_PUBLIC_STELLAR_NETWORK is not set; assuming TESTNET. " +
      "Set it to the deployment's network — deriving with the wrong network produces wrong canonical ids.",
  );
}

const client = new MongoClient(MONGODB_URI);
let report;
try {
  await client.connect();
  report = await migrateEventIds(client.db(DB_NAME), {
    collections: onlyCollection ? [onlyCollection] : undefined,
    apply,
    network: NETWORK_PASSPHRASE,
  });
} finally {
  await client.close();
}

const serialized = JSON.stringify(report, null, 2);
console.log(serialized);
if (outFile) {
  writeFileSync(outFile, serialized);
  console.error(`[migrate-indexer-event-ids] report written to ${outFile}`);
}
if (report.totals.collisions > 0) {
  console.error(`[migrate-indexer-event-ids] ${report.totals.collisions} collision(s) found — review the report.`);
  process.exitCode = 1;
}
