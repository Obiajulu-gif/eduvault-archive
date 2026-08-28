import { COLLECTIONS } from "../backend/schemaContracts.js";
import { planEventIdRewrite, computeQuarantineKey } from "./eventIdentity.js";

/**
 * Re-key existing indexer rows to the deterministic `evt_v1_` scheme (#630)
 * and produce a collision report. Pure orchestration over `planEventIdRewrite`
 * — no Mongo client, no CLI; the runnable wrapper is
 * `scripts/migrations/migrate-indexer-event-ids.mjs`.
 *
 * For each `sync_events` / `dead_letter_events` row:
 *   - unchanged  : already at its canonical id.
 *   - rewrite    : canonical id differs and is free -> re-inserted under the
 *                  new `_id` (keeping `createdAt`), old row deleted.
 *   - collision  : canonical id differs but is already taken -> the earlier
 *                  `createdAt` wins, the other row is dropped, both ids land in
 *                  the report.
 *   - quarantine : the raw event can't be identified -> moved to
 *                  `indexer_quarantine`, recorded in the report.
 *
 * Never calls `applyIndexedEvent`: only `_id`s are rewritten and
 * un-identifiable rows moved aside, so the migration cannot itself double-apply
 * anything. Idempotent — a second run re-derives the same ids and reports
 * all-`unchanged`.
 *
 * Time: O(D) over the D scanned rows, streamed via cursor. Space: O(1) per row
 * plus O(collisions + quarantined) for the report, both expected << D.
 *
 * @param {import('mongodb').Db} db
 * @param {object} opts
 * @param {string[]} [opts.collections]  Subset of ["sync_events","dead_letter_events"] (default: both).
 * @param {boolean}  [opts.apply]        Perform writes (default: false — report only).
 * @param {string}   [opts.network]      Canonical network passphrase for the deployment.
 * @returns {Promise<object>} the migration report.
 */
export async function migrateEventIds(db, { collections, apply = false, network = null } = {}) {
  const targets = (collections && collections.length
    ? collections
    : [COLLECTIONS.syncEvents, COLLECTIONS.deadLetterEvents]
  ).filter((name) => name === COLLECTIONS.syncEvents || name === COLLECTIONS.deadLetterEvents);

  const report = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    network: network ?? null,
    dryRun: !apply,
    collections: {},
    totals: { scanned: 0, unchanged: 0, rewritten: 0, collisions: 0, quarantined: 0 },
  };

  for (const name of targets) {
    const bucket = { scanned: 0, unchanged: 0, rewritten: 0, collisions: [], quarantined: [] };
    await migrateOneCollection(db, name, bucket, { apply, network });
    report.collections[name] = bucket;
    report.totals.scanned += bucket.scanned;
    report.totals.unchanged += bucket.unchanged;
    report.totals.rewritten += bucket.rewritten;
    report.totals.collisions += bucket.collisions.length;
    report.totals.quarantined += bucket.quarantined.length;
  }

  report.finishedAt = new Date().toISOString();
  return report;
}

/** The stored representation of the event to re-derive identity from. */
function storedEvent(doc) {
  return doc.parsed ?? doc.raw ?? null;
}

async function iterate(col) {
  if (typeof col.find === "function") {
    const cursor = col.find({}, { batchSize: 500 });
    if (typeof cursor[Symbol.asyncIterator] === "function") return cursor;
    return (await cursor.toArray())[Symbol.iterator]();
  }
  const records = col.records instanceof Map ? Array.from(col.records.values()) : [];
  return records[Symbol.iterator]();
}

async function migrateOneCollection(db, name, bucket, { apply, network }) {
  const col = db.collection(name);
  const quarantineCol = db.collection(COLLECTIONS.indexerQuarantine);

  for await (const doc of await iterate(col)) {
    bucket.scanned += 1;
    const raw = storedEvent(doc);
    const plan = planEventIdRewrite({ currentId: doc._id, rawEvent: raw, network });

    if (plan.status === "unchanged") {
      bucket.unchanged += 1;
      continue;
    }

    if (plan.status === "quarantine") {
      const key = computeQuarantineKey({ source: doc.source ?? raw?.source ?? "stellar", rawEvent: raw });
      bucket.quarantined.push({ collection: name, from: String(doc._id), quarantineId: key, reason: plan.reason });
      if (apply) {
        const now = new Date();
        await quarantineCol.updateOne(
          { _id: key },
          {
            $set: {
              source: doc.source ?? raw?.source ?? "stellar",
              type: doc.type ?? raw?.type ?? null,
              raw: doc.raw ?? raw ?? null,
              parsed: doc.parsed ?? null,
              reason: plan.reason,
              status: "pending",
              lastSeenAt: now,
              migratedFrom: { collection: name, _id: String(doc._id) },
            },
            $setOnInsert: { createdAt: now },
          },
          { upsert: true },
        );
        await col.deleteOne({ _id: doc._id });
      }
      continue;
    }

    // plan.status === "rewrite"
    const target = plan.canonicalId;
    const clash = await col.findOne({ _id: target });

    if (!clash) {
      bucket.rewritten += 1;
      if (apply) await reinsertUnder(col, doc, target);
      continue;
    }

    // Two historical rows canonicalise to one id. Keep the earlier createdAt.
    const keepExisting = timeOf(clash.createdAt) <= timeOf(doc.createdAt);
    bucket.collisions.push({
      collection: name,
      canonicalId: target,
      keptId: String(keepExisting ? clash._id : doc._id),
      keptCreatedAt: (keepExisting ? clash.createdAt : doc.createdAt) ?? null,
      droppedId: String(keepExisting ? doc._id : clash._id),
      droppedCreatedAt: (keepExisting ? doc.createdAt : clash.createdAt) ?? null,
      type: doc.type ?? clash.type ?? null,
    });
    if (apply) {
      if (keepExisting) {
        await col.deleteOne({ _id: doc._id });
      } else {
        await col.deleteOne({ _id: clash._id });
        await reinsertUnder(col, doc, target);
      }
    }
  }
}

function timeOf(value) {
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

async function reinsertUnder(col, doc, newId) {
  const { _id, ...rest } = doc;
  await col.insertOne({ _id: newId, ...rest, migratedFrom: String(_id) });
  await col.deleteOne({ _id });
}
