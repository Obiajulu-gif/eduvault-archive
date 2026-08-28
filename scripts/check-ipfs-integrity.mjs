#!/usr/bin/env node
/**
 * IPFS pin state integrity synchronizer (#290)
 *
 * Database listings should always match live IPFS pins, so a buyer never
 * lands on a dead file link. This script:
 *
 *   1. Streams every `materials` document that has a `storageKey` (the CID
 *      Pinata returned when the file was originally uploaded).
 *   2. Builds the set of CIDs Pinata currently reports as pinned.
 *   3. Reports every stored CID that is missing from that set.
 *   4. In auto-repair mode, asks Pinata to re-pin each missing CID by hash.
 *
 * Every material with a storageKey is checked, including soft-deleted or
 * unlisted ones: `src/lib/db/softDelete.js` documents that entitlement-backed
 * downloads for past buyers are intentionally not filtered by catalog
 * visibility, so a retired listing's file must stay pinned too.
 *
 * "Unpinned" and "missing" are the same condition in Pinata's current Files
 * API: deleting a file un-pins it outright (there is no separate
 * pinned/unpinned status on a file that still exists) — see
 * https://docs.pinata.cloud/api-reference/endpoint/ipfs/unpin-file. A CID is
 * therefore either present in `pinata.files.public.list()` or it isn't.
 *
 * Usage:
 *   node scripts/check-ipfs-integrity.mjs
 *   AUTO_REPAIR=true node scripts/check-ipfs-integrity.mjs
 *
 * Environment variables:
 *   MONGODB_URI       — required; MongoDB connection string
 *   MONGODB_DB        — optional; database name (default: "eduvault")
 *   PINATA_JWT        — required; Pinata API JWT (same credential as the app)
 *   AUTO_REPAIR       — optional; "true" to re-pin missing CIDs by hash.
 *                       Default is dry-run: report only, no Pinata mutation.
 *   BATCH_SIZE        — optional; materials cursor batch size (default: 200)
 *   PINATA_PAGE_LIMIT — optional; Pinata list page size (default: 1000)
 */

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { PinataSDK } from "pinata";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env.local"), override: false });
config({ path: resolve(__dirname, "../.env"), override: false });

// ── Config ────────────────────────────────────────────────────────────────────

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "eduvault";
const PINATA_JWT = process.env.PINATA_JWT;
const AUTO_REPAIR = process.env.AUTO_REPAIR === "true";
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? "200");
const PINATA_PAGE_LIMIT = Number(process.env.PINATA_PAGE_LIMIT ?? "1000");

function log(level, message, extra = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra }));
}

if (!MONGODB_URI) {
  log("error", "MONGODB_URI is not set. Aborting.");
  process.exit(1);
}
if (!PINATA_JWT) {
  log("error", "PINATA_JWT is not set. Aborting.");
  process.exit(1);
}
if (!Number.isFinite(BATCH_SIZE) || BATCH_SIZE <= 0) {
  log("error", `Invalid BATCH_SIZE: "${process.env.BATCH_SIZE}". Must be a positive number.`);
  process.exit(1);
}
if (!Number.isFinite(PINATA_PAGE_LIMIT) || PINATA_PAGE_LIMIT <= 0) {
  log("error", `Invalid PINATA_PAGE_LIMIT: "${process.env.PINATA_PAGE_LIMIT}". Must be a positive number.`);
  process.exit(1);
}

// ── Pinata ────────────────────────────────────────────────────────────────────

/**
 * Enumerate every CID Pinata currently has pinned, via the SDK's built-in
 * auto-pagination (`for await` on `.list()` walks every page for us).
 *
 * Time:  O(ceil(P / PINATA_PAGE_LIMIT)) network round trips, O(P) to enumerate.
 * Space: O(P) — one Set entry per pinned file, P = total pinned files.
 *
 * Pulling the full pin set once and diffing it in memory (O(1) average
 * lookup per material) beats issuing one filtered `.list().cid(x)` request
 * per material: that would cost O(M) round trips instead of O(P / pageSize),
 * and P and M are the same order of magnitude here (each material pins at
 * least one file). https://docs.pinata.cloud/sdk/files/public/list
 */
async function fetchPinnedCidSet(pinata) {
  const pinned = new Set();
  for await (const file of pinata.files.public.list().limit(PINATA_PAGE_LIMIT)) {
    if (file.cid && file.cid !== "pending") {
      pinned.add(file.cid);
    }
  }
  return pinned;
}

/**
 * Ask Pinata to re-pin each unique missing CID by hash. This does not
 * re-upload file bytes — it tells Pinata to fetch the content from the IPFS
 * network and pin it, matching the "auto-repair mode" acceptance criterion.
 * A successful call only means Pinata *queued* the retrieval; it can still
 * land on a terminal failure state (e.g. "bad_host_node") if no IPFS node
 * still has the original bytes. Not a synchronous pin guarantee — see
 * implementation.md for the full caveat.
 * https://docs.pinata.cloud/sdk/upload/public/cid
 *
 * Time: O(U) network calls, U = number of unique missing CIDs (U <= M).
 */
async function repairMissingCids(pinata, uniqueCids) {
  const summary = { repaired: 0, failed: 0 };

  for (const cid of uniqueCids) {
    try {
      await pinata.upload.public.cid(cid);
      summary.repaired++;
      log("info", "Re-pin requested", { storageKey: cid });
    } catch (err) {
      summary.failed++;
      log("error", "Re-pin request failed", { storageKey: cid, error: err.message });
    }
  }

  return summary;
}

// ── MongoDB ───────────────────────────────────────────────────────────────────

/**
 * Stream `materials` documents with a storageKey and diff each CID against
 * the pinned set.
 *
 * Time:  O(M) cursor iteration, O(1) average per Set.has lookup => O(M) total.
 * Space: O(1) additional beyond the pinned set — documents are streamed
 *        through the cursor, never buffered as a whole array.
 */
async function findDiscrepancies(materialsCollection, pinnedCidSet) {
  const cursor = materialsCollection
    .find(
      { storageKey: { $exists: true, $nin: [null, ""] } },
      { projection: { storageKey: 1, title: 1, isDeleted: 1, visibility: 1 } },
    )
    .batchSize(BATCH_SIZE);

  const discrepancies = [];
  let checked = 0;

  for await (const material of cursor) {
    const cid = material.storageKey;
    if (typeof cid !== "string" || cid.trim() === "") continue;

    checked++;
    if (!pinnedCidSet.has(cid)) {
      discrepancies.push({
        materialId: material._id.toString(),
        title: material.title || null,
        storageKey: cid,
        isDeleted: material.isDeleted === true,
        visibility: material.visibility || null,
      });
    }
  }

  return { discrepancies, checked };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const mode = AUTO_REPAIR ? "AUTO_REPAIR" : "DRY_RUN";
  log("info", `Starting IPFS pin integrity check (mode=${mode})`);

  const pinata = new PinataSDK({ pinataJwt: PINATA_JWT });

  try {
    await pinata.testAuthentication();
  } catch (err) {
    log("error", "Pinata authentication failed. Aborting.", { error: err.message });
    process.exit(1);
  }

  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    const db = client.db(MONGODB_DB);
    const materials = db.collection("materials");

    log("info", "Fetching pinned CID set from Pinata...");
    const pinnedCidSet = await fetchPinnedCidSet(pinata);
    log("info", `Pinata reports ${pinnedCidSet.size} pinned file(s).`);

    log("info", "Scanning materials collection for stored CIDs...");
    const { discrepancies, checked } = await findDiscrepancies(materials, pinnedCidSet);
    log("info", `Checked ${checked} material(s) with a storageKey.`);
    log("info", `Found ${discrepancies.length} missing/unpinned CID(s).`);

    for (const discrepancy of discrepancies) {
      log("warn", "Missing/unpinned CID", discrepancy);
    }

    let repairSummary = null;
    if (discrepancies.length > 0) {
      const uniqueCids = [...new Set(discrepancies.map((d) => d.storageKey))];
      if (AUTO_REPAIR) {
        log("info", `AUTO_REPAIR enabled — re-pinning ${uniqueCids.length} unique CID(s)...`);
        repairSummary = await repairMissingCids(pinata, uniqueCids);
      } else {
        log("info", "Dry-run mode — no re-pin requests sent. Set AUTO_REPAIR=true to re-pin missing CIDs.");
      }
    }

    log("info", "─── Summary ───", {
      mode,
      pinnedInPinata: pinnedCidSet.size,
      materialsChecked: checked,
      discrepancies: discrepancies.length,
      repaired: repairSummary?.repaired ?? 0,
      repairFailed: repairSummary?.failed ?? 0,
    });
  } finally {
    await client.close();
    log("info", "Done.");
  }
}

run().catch((err) => {
  log("error", "Fatal error", { error: err.message, stack: err.stack });
  process.exit(1);
});
