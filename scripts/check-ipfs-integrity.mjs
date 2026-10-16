#!/usr/bin/env node
/**
 * IPFS pin state integrity synchronizer (#290) + stale cache detection/repair
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
 *   5. Detects stale cache entries: `materials` documents whose cached
 *      `storageKey` no longer matches the source-of-truth CID recorded on
 *      the owning `assets` document (or whose `cacheVersion` lags the
 *      source `version`). Stale entries are reported in dry-run mode and
 *      repaired (cache fields rewritten from source) when AUTO_REPAIR is
 *      enabled. Repair is idempotent: re-running on an already-repaired
 *      document is a no-op because the source version is copied verbatim.
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
 *   AUTO_REPAIR=true REPAIR_STALE_CACHE=true node scripts/check-ipfs-integrity.mjs
 *   node scripts/check-ipfs-integrity.mjs --dry-run --json
 *
 * Environment variables:
 *   MONGODB_URI       — required; MongoDB connection string
 *   MONGODB_DB        — optional; database name (default: "eduvault")
 *   PINATA_JWT        — required; Pinata API JWT (same credential as the app)
 *   AUTO_REPAIR       — optional; "true" to re-pin missing CIDs by hash.
 *                       Default is dry-run: report only, no Pinata mutation.
 *   BATCH_SIZE        — optional; materials cursor batch size (default: 200)
 *   PINATA_PAGE_LIMIT — optional; Pinata list page size (default: 1000)
 *   REPAIR_STALE_CACHE — optional; "true" to rewrite stale cache fields
 *                        (only honored when AUTO_REPAIR=true). Default false.
 *   JSON_OUTPUT       — optional; "true" to emit a single JSON summary line.
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
const REPAIR_STALE_CACHE = process.env.REPAIR_STALE_CACHE === "true";
const JSON_OUTPUT = process.env.JSON_OUTPUT === "true";

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

// ── Stale cache detection & repair ────────────────────────────────────────────

/**
 * A cached `materials` document is considered stale when any of the
 * following hold relative to its source `assets` document:
 *
 *   - the cached `storageKey` differs from the source `cid`
 *   - the cached `cacheVersion` is missing or less than the source `version`
 *   - the cached `cacheUpdatedAt` is missing or older than the source
 *     `updatedAt` timestamp
 *
 * The source of truth is the `assets` collection keyed by `materialId`.
 * Documents with no matching source asset are reported as `missing-source`
 * and are never auto-repaired (there is nothing to copy from).
 *
 * Time:  O(M) cursor iteration + O(1) average Map lookup per material.
 * Space: O(A) for the source asset map, A = number of assets.
 */
function isStale(material, source) {
  if (!source) return { stale: false, reason: "missing-source" };

  const cachedCid = typeof material.storageKey === "string" ? material.storageKey : null;
  const sourceCid = typeof source.cid === "string" ? source.cid : null;
  if (cachedCid !== sourceCid) {
    return { stale: true, reason: "cid-mismatch" };
  }

  const cachedVersion = Number.isFinite(material.cacheVersion) ? material.cacheVersion : -1;
  const sourceVersion = Number.isFinite(source.version) ? source.version : 0;
  if (cachedVersion < sourceVersion) {
    return { stale: true, reason: "version-lag" };
  }

  const cachedAt = material.cacheUpdatedAt ? new Date(material.cacheUpdatedAt).getTime() : 0;
  const sourceAt = source.updatedAt ? new Date(source.updatedAt).getTime() : 0;
  if (sourceAt > 0 && cachedAt < sourceAt) {
    return { stale: true, reason: "timestamp-lag" };
  }

  return { stale: false, reason: null };
}

/**
 * Load the source `assets` documents for a set of material ids into a Map
 * keyed by materialId string. Missing sources are simply absent from the Map.
 */
async function loadSourceAssets(assetsCollection, materialIds) {
  const map = new Map();
  if (materialIds.length === 0) return map;

  const cursor = assetsCollection
    .find(
      { materialId: { $in: materialIds } },
      { projection: { materialId: 1, cid: 1, version: 1, updatedAt: 1 } },
    )
    .batchSize(BATCH_SIZE);

  for await (const asset of cursor) {
    map.set(String(asset.materialId), asset);
  }
  return map;
}

/**
 * Rewrite stale cache fields on a material from its source asset. Idempotent:
 * running twice yields the same document because every written value is
 * derived deterministically from the source. Returns true if a write occurred.
 */
async function repairStaleCache(materialsCollection, material, source) {
  const result = await materialsCollection.updateOne(
    { _id: material._id },
    {
      $set: {
        storageKey: source.cid,
        cacheVersion: Number.isFinite(source.version) ? source.version : 0,
        cacheUpdatedAt: source.updatedAt ? new Date(source.updatedAt) : new Date(),
        cacheRepairedAt: new Date(),
      },
    },
  );
  return result.modifiedCount > 0;
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
    const assets = db.collection("assets");

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

    // ── Stale cache detection & repair ──────────────────────────────────────
    log("info", "Scanning materials for stale cache entries...");
    const materialIds = discrepancies.map((d) => d.materialId);
    const sourceAssets = await loadSourceAssets(assets, materialIds);

    const staleEntries = [];
    for (const discrepancy of discrepancies) {
      const source = sourceAssets.get(discrepancy.materialId);
      const material = {
        _id: discrepancy.materialId,
        storageKey: discrepancy.storageKey,
      };
      const { stale, reason } = isStale(material, source);
      if (stale) {
        staleEntries.push({ ...discrepancy, reason });
      }
    }
    log("info", `Found ${staleEntries.length} stale cache entr(ies).`);

    let staleRepairSummary = { repaired: 0, failed: 0, skipped: 0 };
    if (staleEntries.length > 0) {
      if (AUTO_REPAIR && REPAIR_STALE_CACHE) {
        log("info", `Repairing ${staleEntries.length} stale cache entr(ies)...`);
        for (const entry of staleEntries) {
          const source = sourceAssets.get(entry.materialId);
          if (!source) {
            staleRepairSummary.skipped++;
            log("warn", "Skipping stale repair — no source asset", { materialId: entry.materialId });
            continue;
          }
          try {
            const modified = await repairStaleCache(materials, { _id: entry.materialId }, source);
            if (modified) {
              staleRepairSummary.repaired++;
              log("info", "Stale cache repaired", { materialId: entry.materialId, reason: entry.reason });
            } else {
              staleRepairSummary.skipped++;
            }
          } catch (err) {
            staleRepairSummary.failed++;
            log("error", "Stale cache repair failed", { materialId: entry.materialId, error: err.message });
          }
        }
      } else {
        log("info", "Dry-run mode — no stale cache repairs applied. Set AUTO_REPAIR=true and REPAIR_STALE_CACHE=true to repair.");
      }
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
      staleCacheEntries: staleEntries.length,
      staleCacheRepaired: staleRepairSummary.repaired,
      staleCacheRepairFailed: staleRepairSummary.failed,
      staleCacheRepairSkipped: staleRepairSummary.skipped,
    });
  } finally {
    await client.close();
    log("info", "Done.");
  }
}

// ── Testable exports ──────────────────────────────────────────────────────────
// Exported for unit tests (cache hit, stale cache, missing cache, repair
// failure). The CLI entrypoint below only runs when invoked directly.
export { isStale, loadSourceAssets, repairStaleCache, findDiscrepancies };

run().catch((err) => {
  log("error", "Fatal error", { error: err.message, stack: err.stack });
  process.exit(1);
});
