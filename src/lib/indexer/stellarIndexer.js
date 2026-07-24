import { createHash } from "node:crypto";

import { COLLECTIONS } from "../backend/schemaContracts.js";
import { incrementCounter, setGauge } from "../telemetry/metrics.js";
import { logger } from "../logger.js";
import { auditLog } from "../api/audit.js";
import { runWithContext } from "../telemetry/context.js";
import { withSpan } from "../telemetry/tracing.js";
import { decodeContractEvent } from "./eventDecoder.js";
import { sendReceiptIfEligible } from "../email.js";

function duplicateKey(error) {
  return error?.code === 11000;
}

/** Mongo rejects transactions on standalone servers (local docker-compose,
 *  CI). Detect that once and fall back to unsessioned writes rather than
 *  dead-lettering every event on a developer machine. */
function transactionsUnsupported(error) {
  if (error?.codeName === "IllegalOperation" || error?.code === 20) return true;
  return /Transaction numbers are only allowed on a replica set member or mongos/i.test(
    String(error?.message || ""),
  );
}

let transactionSupport = "unknown";

/** Dead-letter rows are keyed by event identity so that a repeatedly failing
 *  event accumulates one row with a rising retryCount. Events that carry no
 *  stable identity (malformed payloads) still need a deterministic key, so we
 *  hash the payload instead of generating a random one — a random key would
 *  write a fresh row per attempt and never reach the retry ceiling. */
export function deadLetterId(event, source = "stellar") {
  const identity = eventId(event);
  if (identity) return identity;

  let serialized;
  try {
    serialized = JSON.stringify(event);
  } catch {
    serialized = String(event);
  }
  return `${source}:unidentified:${createHash("sha256").update(serialized).digest("hex").slice(0, 32)}`;
}

export function eventId(event) {
  if (event.id || event.eventId) return String(event.id || event.eventId);

  const identity = [
    event.network || event.source || "stellar",
    event.contractId || event.contract || "unknown-contract",
    event.ledger ?? event.ledgerSequence,
    event.transactionHash || event.txHash,
    event.index ?? event.eventIndex ?? event.position,
  ];

  return identity.some((part) => part === undefined || part === null || part === "")
    ? ""
    : identity.map(String).join(":");
}

function writeOptions(session, extra = {}) {
  return session ? { ...extra, session } : extra;
}

async function applyEventStateMachine(db, event, { now, session }) {
  const id = eventId(event);
  if (!id) {
    throw new Error("Indexed event is missing a stable id");
  }

  const syncEvents = db.collection(COLLECTIONS.syncEvents);
  const existing = await syncEvents.findOne({ _id: id }, writeOptions(session));
  if (existing?.status === "applied") {
    return { eventId: id, skipped: true };
  }

  try {
    await syncEvents.insertOne({
      _id: id,
      eventId: id,
      type: event.type,
      source: event.source || "stellar",
      network: event.network || event.source || "stellar",
      contractId: event.contractId || event.contract || null,
      ledger: event.ledger ?? event.ledgerSequence ?? null,
      transactionHash: event.transactionHash || event.txHash || null,
      position: event.index ?? event.eventIndex ?? event.position ?? null,
      status: "applying",
      raw: event,
      createdAt: now,
      updatedAt: now,
    }, writeOptions(session));
  } catch (error) {
    if (!duplicateKey(error)) throw error;

    const raced = await syncEvents.findOne({ _id: id }, writeOptions(session));
    if (raced?.status === "applied") {
      return { eventId: id, skipped: true };
    }
  }

  if (event.type === "material.registered") {
    await db.collection(COLLECTIONS.materials).updateOne(
      { materialId: event.materialId },
      {
        $set: {
          materialId: event.materialId,
          chainContractId: event.contractId || null,
          chainLedger: event.ledger || null,
          chainTxHash: event.transactionHash || event.txHash || null,
          syncStatus: "indexed",
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
          visibility: "public",
        },
      },
      writeOptions(session, { upsert: true })
    );
  }

  if (event.type === "purchase.completed") {
    const buyerAddress = String(event.buyerAddress || "").toLowerCase();
    await db.collection(COLLECTIONS.purchases).updateOne(
      { materialId: event.materialId, buyerAddress },
      {
        $set: {
          materialId: event.materialId,
          buyerAddress,
          sellerAddress: event.sellerAddress || null,
          chainTxHash: event.transactionHash || event.txHash || null,
          amount: event.amount || null,
          asset: event.asset || null,
          status: "settled",
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      writeOptions(session, { upsert: true })
    );

    await db.collection(COLLECTIONS.entitlementCache).updateOne(
      { materialId: event.materialId, buyerAddress },
      {
        $set: {
          materialId: event.materialId,
          buyerAddress,
          active: true,
          source: "stellar",
          chainTxHash: event.transactionHash || event.txHash || null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      writeOptions(session, { upsert: true })
    );
  }

  await syncEvents.updateOne(
    { _id: id },
    {
      $set: {
        status: "applied",
        appliedAt: now,
        updatedAt: now,
        lastError: null,
      },
    },
    writeOptions(session),
  );

  return { eventId: id, skipped: false };
}

export async function applyIndexedEvent(db, event, { now = new Date() } = {}) {
  const client = db.client;
  if (!client || typeof client.startSession !== "function" || transactionSupport === "unavailable") {
    return applyEventStateMachine(db, event, { now, session: null });
  }

  const session = client.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await applyEventStateMachine(db, event, { now, session });
    });
    transactionSupport = "available";
    return result;
  } catch (error) {
    if (!transactionsUnsupported(error)) throw error;

    // Standalone Mongo. The projection writes below are individually
    // idempotent (upserts keyed on natural keys, guarded by the sync_events
    // receipt), so losing atomicity costs us a torn write window on crash,
    // which `repairPartialIndexedEvents` already reconciles. Latch the mode so
    // we probe once per process rather than per event.
    transactionSupport = "unavailable";
    logger.warn(
      { reason: error?.message },
      "[Indexer] Mongo transactions unavailable (standalone server); falling back to non-transactional writes",
    );
    incrementCounter("indexer_transaction_fallback_total", { source: event.source || "stellar" });
    return applyEventStateMachine(db, event, { now, session: null });
  } finally {
    await session.endSession();
  }
}

export async function runIndexerBatch({ db, eventSource, source = "stellar", limit = 100, applyFn = applyIndexedEvent }) {
  return runWithContext({ jobType: "stellar-sync" }, async () => {
  const startedAt = Date.now();
  const stateId = `${source}:events`;
  const state = await db.collection(COLLECTIONS.syncState).findOne({ _id: stateId });
  let batch;
  try {
    batch = await withSpan("stellar.sync.fetch", { source, limit }, () => eventSource.getEvents({ cursor: state?.cursor || null, limit }));
  } catch (error) {
    incrementCounter("stellar_sync_batches_total", { source, outcome: "failed" });
    incrementCounter("rpc_errors_total", { operation: "getEvents" });
    auditLog({ event: "stellar_sync_failed", action: "fetch", resource: "stellar-sync", source, outcome: "failed", reason: error.message });
    throw error;
  }
  const events = batch.events || [];
  let applied = 0;
  let skipped = 0;

  const maxRetries = Number(process.env.INDEXER_MAX_RETRIES || 3);

  for (const event of events) {
    try {
      const result = await withSpan("stellar.sync.apply", { source, eventType: event.type }, () => applyFn(db, { ...event, source }));
      if (result.skipped) skipped += 1;
      else applied += 1;

      // Both outcomes are successes: `skipped` means the event was already
      // applied (a replay), which is exactly what idempotency is for. Either
      // way the event is settled, so retire any dead-letter row for it.
      // Previously the skip path incremented retryCount instead, so replaying
      // a healthy event drove its dead-letter to a terminal `failed` state.
      if (result.eventId) {
        try {
          await db.collection(COLLECTIONS.deadLetterEvents).deleteOne({ _id: result.eventId });
        } catch {
          // Cleanup is best-effort; the row is harmless if it outlives us and
          // reprocessDeadLetters will retire it on the next pass.
        }
      }
    } catch (err) {
      const id = deadLetterId(event, source);
      incrementCounter("stellar_sync_events_total", { source, outcome: "failed" });
      auditLog({ event: "stellar_sync_event_failed", action: "apply", resource: "stellar-event", source, eventId: id, outcome: "failed", reason: err?.message });
      try {
        await db.collection(COLLECTIONS.syncEvents).updateOne(
          { _id: id },
          {
            $set: {
              status: "failed",
              lastError: String(err?.message || err),
              updatedAt: new Date(),
            },
          },
        );
      } catch {
        // The durable dead-letter below remains the source of retry truth when
        // the receipt itself could not be updated.
      }
      const dlCol = db.collection(COLLECTIONS.deadLetterEvents);
      const existing = await dlCol.findOne({ _id: id });
      const retryCount = (existing?.retryCount || 0) + 1;
      const status = retryCount > maxRetries ? 'failed' : 'retryable';
      await dlCol.updateOne(
        { _id: id },
        {
          $set: {
            raw: event,
            lastError: String(err?.message || err),
            retryCount,
            lastAttemptedAt: new Date(),
            status,
            source,
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      );
    }
  }

  const previousLedger = state?.lastLedger || 0;
  // `latestLedger` from the RPC getEvents response is the chain tip as the
  // server sees it, not the ledger we reached. Keeping the two apart is what
  // makes real lag computable without the extra getLatestLedger call that
  // observability-slos.md assumed we'd need.
  const tipLedger = batch.lastLedger || previousLedger;
  const processedLedger = events.reduce(
    (highest, event) => Math.max(highest, Number(event.ledger ?? event.ledgerSequence ?? 0) || 0),
    state?.lastProcessedLedger || 0,
  );

  // A short page means the RPC handed us everything it had, so we are current
  // with the tip even if no events matched our contracts on a quiet chain. A
  // full page means there is very likely more behind it, and the distance
  // between the tip and the newest event we applied is the real backlog.
  const drained = events.length < limit;
  const ledgerLag = drained ? 0 : Math.max(0, tipLedger - processedLedger);

  await db.collection(COLLECTIONS.syncState).updateOne(
    { _id: stateId },
    {
      $set: {
        _id: stateId,
        source,
        cursor: batch.nextCursor || state?.cursor || null,
        lastLedger: tipLedger,
        lastProcessedLedger: processedLedger,
        ledgerLag,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  // Ledger lag: how far behind the chain tip this batch left us. A healthy
  // indexer keeps this near zero; a growing value means we're falling
  // behind the chain (acceptance criterion: "indexer ledger lag").
  setGauge("indexer_ledger_lag", { source }, ledgerLag);
  setGauge("indexer_last_ledger", { source }, tipLedger);
  setGauge("indexer_last_processed_ledger", { source }, processedLedger);
  incrementCounter("indexer_events_applied_total", { source }, applied);
  incrementCounter("indexer_events_skipped_total", { source }, skipped);
  incrementCounter("stellar_sync_events_total", { source, outcome: "applied" }, applied);
  incrementCounter("stellar_sync_events_total", { source, outcome: "skipped" }, skipped);
  incrementCounter("stellar_sync_batches_total", { source, outcome: "success" });

 // Defensive: test doubles for the Mongo collection may not implement
  // countDocuments, only find/insertOne/updateOne/deleteOne. Fall back to
  // counting via find() so this works against both real Mongo and doubles.
  let deadLetterCount = 0;
  try {
    const dlCol = db.collection(COLLECTIONS.deadLetterEvents);
    if (typeof dlCol.countDocuments === "function") {
      deadLetterCount = await dlCol.countDocuments({ source, status: { $in: ["retryable", "failed"] } });
    } else if (typeof dlCol.find === "function") {
      const cursor = dlCol.find({ source, status: { $in: ["retryable", "failed"] } });
      for await (const _doc of cursor) deadLetterCount += 1;
    }
  } catch {
    deadLetterCount = 0;
  }
  setGauge("indexer_dead_letter_count", { source }, deadLetterCount);

  logger.info(
    { source, applied, skipped, tipLedger, processedLedger, ledgerLag, deadLetterCount },
    "[Indexer] Batch processed"
  );
  auditLog({ event: "stellar_sync_completed", action: "batch", resource: "stellar-sync", source, outcome: "success", status: 200, ledger: tipLedger, durationMs: Date.now() - startedAt });

  return { applied, skipped, nextCursor: batch.nextCursor || null, ledgerLag, drained };
  });
}

export function createJsonRpcEventSource({
  rpcUrl,
  contractId,
  fetchImpl = fetch,
  networkPassphrase,
  manifestOverrides,
}) {
  const contractIds = Array.isArray(contractId)
    ? contractId.filter(Boolean)
    : contractId
      ? [contractId]
      : [];

  return {
    async getEvents({ cursor, limit, startLedger }) {
      const response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getEvents",
          params: {
            ...(cursor ? {} : startLedger ? { startLedger } : {}),
            filters: contractIds.length > 0 ? [{ contractIds }] : [],
            pagination: { cursor, limit },
          },
        }),
      });
      const payload = await response.json();
      if (payload.error) {
        throw new Error(payload.error.message || "Stellar RPC getEvents failed");
      }

      const rawEvents = payload.result?.events || [];

      // Decode/validate each raw RPC event against the versioned schema
      // (#7) before it reaches projection code, which expects normalized
      // fields (`type`, `materialId`, `buyerAddress`, ...) — not raw XDR
      // topics/values. Events that fail decoding (unknown event/version,
      // unlisted contract, malformed payload) are logged and dropped here
      // rather than thrown, so one bad event can't block the rest of the
      // batch.
      const events = [];
      let unknownOrInvalid = 0;
      for (const rawEvent of rawEvents) {
        const result = decodeContractEvent(rawEvent, { networkPassphrase, manifestOverrides });
        if (result.ok) {
          events.push(result.event);
        } else {
          unknownOrInvalid += 1;
        }
      }
      if (unknownOrInvalid > 0) {
        incrementCounter("indexer_events_undecodable_total", { source: "stellar" }, unknownOrInvalid);
      }

      return {
        events,
        nextCursor: payload.result?.cursor || null,
        lastLedger: payload.result?.latestLedger || null,
      };
    },
  };
}

/**
 * Retry dead-lettered events.
 *
 * Defaults to `retryable` only: `failed` is the terminal state an event
 * reaches after exhausting INDEXER_MAX_RETRIES, and sweeping it back in on
 * every pass made that ceiling meaningless. Operators can still opt into
 * terminal rows explicitly (after fixing whatever poisoned them) by passing
 * `statuses: ['retryable', 'failed']`.
 */
export async function reprocessDeadLetters(db, { statuses = ['retryable'], limit = 100, applyFn = applyIndexedEvent } = {}) {
  const dlCol = db.collection(COLLECTIONS.deadLetterEvents);
  const maxRetries = Number(process.env.INDEXER_MAX_RETRIES || 3);
  const items = [];

  if (typeof dlCol.find === 'function') {
    const cursor = dlCol.find({ status: { $in: statuses } }).limit(limit);
    for await (const doc of cursor) items.push(doc);
  } else {
    const records = dlCol.records instanceof Map ? Array.from(dlCol.records.values()) : [];
    for (const r of records) if (statuses.includes(r.status)) items.push(r);
  }

  const reprocessed = [];
  const exhausted = [];
  for (const entry of items.slice(0, limit)) {
    if (!entry.raw) {
      exhausted.push({ id: entry._id, error: 'missing raw event' });
      continue;
    }

    try {
      await applyFn(db, entry.raw);
      await dlCol.deleteOne({ _id: entry._id });
      reprocessed.push({ id: entry._id });
    } catch (err) {
      // One attempt per pass. The previous version retried twice inline
      // without recording either try, so a permanently poisoned event burned
      // two applies per pass forever and its retryCount never moved.
      const retryCount = (entry.retryCount || 0) + 1;
      const status = retryCount > maxRetries ? 'failed' : 'retryable';
      await dlCol.updateOne(
        { _id: entry._id },
        {
          $set: {
            lastError: String(err?.message || err),
            lastAttemptedAt: new Date(),
            retryCount,
            status,
          },
        },
        { upsert: true },
      );
      if (status === 'failed') exhausted.push({ id: entry._id, error: String(err?.message || err) });
    }
  }

  return { reprocessed, exhausted };
}

export async function repairPartialIndexedEvents(db, { limit = 100, applyFn = applyIndexedEvent } = {}) {
  const syncEvents = db.collection(COLLECTIONS.syncEvents);
  const candidates = [];

  if (typeof syncEvents.find === "function") {
    const cursor = syncEvents.find({
      $or: [
        { status: { $exists: false } },
        { status: { $in: ["applying", "failed"] } },
      ],
    });
    const bounded = typeof cursor.limit === "function" ? cursor.limit(limit) : cursor;
    for await (const receipt of bounded) candidates.push(receipt);
  } else if (syncEvents.records instanceof Map) {
    for (const receipt of syncEvents.records.values()) {
      if (!receipt.status || ["applying", "failed"].includes(receipt.status)) {
        candidates.push(receipt);
      }
      if (candidates.length >= limit) break;
    }
  }

  const repaired = [];
  const failed = [];
  for (const receipt of candidates.slice(0, limit)) {
    if (!receipt.raw) {
      failed.push({ eventId: receipt._id, error: "missing raw event" });
      continue;
    }
    try {
      await applyFn(db, receipt.raw);
      repaired.push(receipt._id);
    } catch (error) {
      failed.push({ eventId: receipt._id, error: String(error?.message || error) });
    }
  }

  return { scanned: candidates.length, repaired, failed };
}
