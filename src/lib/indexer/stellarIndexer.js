import { COLLECTIONS } from "../backend/schemaContracts.js";
import { parseContractEvent } from "./eventParser.js";
import { invalidateEntitlement } from "../entitlement.js";
import { detectFork, rewindAfterFork } from "./forkDetection.js";

function duplicateKey(error) {
  return error?.code === 11000;
}

/**
 * Classify an error raised while applying an indexed event as either
 * transient (worth retrying automatically — network blips, Mongo
 * connection resets, RPC rate limits) or poison (will never succeed no
 * matter how many times it's retried — a malformed/undecodable event, a
 * programming bug in the apply path). Previously every error was treated
 * identically and only a raw retry-count threshold decided when to give up,
 * so a genuinely poisoned event and a transient blip looked the same in the
 * dead-letter queue until the count happened to cross the threshold (#469).
 *
 * @param {unknown} error
 * @returns {"transient" | "poison"}
 */
export function classifyIndexerError(error) {
  const code = error?.code;
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === 11600) {
    return "transient";
  }
  // A bare numeric HTTP-style status code (whether surfaced as `.code` or
  // nested under `.response.status`/`.status`, since different libraries
  // that throw here shape errors differently) in the 5xx/429 range is
  // treated as a transient server/network condition.
  const status = error?.response?.status ?? error?.status ?? (typeof code === "number" ? code : undefined);
  if (status === 429 || (typeof status === "number" && status >= 500 && status < 600)) {
    return "transient";
  }
  const message = String(error?.message || "").toLowerCase();
  if (
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("socket") ||
    message.includes("topology was destroyed")
  ) {
    return "transient";
  }
  // Validation errors, decode failures, missing-id errors, and anything else
  // unrecognized are treated as poison: retrying without operator
  // intervention won't change the outcome.
  return "poison";
}

export function eventId(event) {
  return (
    event.id ||
    event.eventId ||
    [event.ledger, event.transactionHash || event.txHash, event.topic, event.index]
      .filter(Boolean)
      .join(":")
  );
}

export async function applyIndexedEvent(db, event, { now = new Date(), session = null } = {}) {
  const id = eventId(event);
  if (!id) {
    throw new Error("Indexed event is missing a stable id");
  }

  const options = session ? { session } : {};
  const upsertOptions = session ? { upsert: true, session } : { upsert: true };

  try {
    await db.collection(COLLECTIONS.syncEvents).insertOne(
      {
        _id: id,
        type: event.type,
        source: event.source || "stellar",
        raw: event,
        createdAt: now,
        indexedLedger: event.ledger || null,
        ledgerHash: event.ledgerHash || null,
        txHash: event.transactionHash || event.txHash || null,
      },
      options
    );
  } catch (error) {
    if (duplicateKey(error)) {
      // event already recorded; mark and continue to ensure downstream
      // side-effects (purchases/entitlement/materials) are applied on reprocess.
      var alreadyIndexed = true;
    } else {
      throw error;
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
          indexedLedger: event.ledger || null,
          syncStatus: "indexed",
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
          visibility: "public",
        },
      },
      upsertOptions
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
          purchaseId: event.purchaseId ?? null,
          sellerAddress: event.sellerAddress || null,
          chainTxHash: event.transactionHash || event.txHash || null,
          amount: event.amount || null,
          asset: event.asset || null,
          status: "settled",
          settlementState: "Pending",
          indexedLedger: event.ledger || null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      upsertOptions
    );

    await db.collection(COLLECTIONS.entitlementCache).updateOne(
      { materialId: event.materialId, buyerAddress },
      {
        $set: {
          materialId: event.materialId,
          buyerAddress,
          state: "finalized",
          active: true,
          source: "stellar",
          purchaseId: event.purchaseId ?? null,
          settlementState: "Pending",
          chainTxHash: event.transactionHash || event.txHash || null,
          indexedLedger: event.ledger || null,
          checkedAt: now,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      upsertOptions
    );

    // Only enqueue the receipt email the first time this event is applied —
    // written atomically to side_effect_outbox within the transaction session.
    if (!alreadyIndexed) {
      const purchase = await db.collection(COLLECTIONS.purchases).findOne(
        {
          materialId: event.materialId,
          buyerAddress,
        },
        options
      );
      if (purchase) {
        const deliveryId = `side-effect:email:purchase_receipt:${String(purchase._id)}`;
        await db.collection(COLLECTIONS.sideEffectOutbox || "side_effect_outbox").updateOne(
          { deliveryId },
          {
            $set: {
              sourceAggregate: "purchase",
              sourceId: String(purchase._id),
              intent: {
                type: "email",
                channel: "purchase_receipt",
                payload: { source: "indexer", purchaseId: purchase._id },
              },
              status: "pending",
              deliveryId,
              updatedAt: now,
            },
            $setOnInsert: {
              attemptCount: 0,
              nextAttemptAt: now,
              createdAt: now,
            },
          },
          upsertOptions
        );
      }
    }
  }

  if (event.type === "purchase.refunded") {
    const buyerAddress = String(event.buyerAddress || "").toLowerCase();

    const existingPurchase = await db.collection(COLLECTIONS.purchases).findOne(
      {
        materialId: event.materialId,
        buyerAddress,
      },
      options
    );
    if (isStaleReplay(existingPurchase, event)) {
      return { eventId: id, skipped: true };
    }

    await db.collection(COLLECTIONS.purchases).updateOne(
      { materialId: event.materialId, buyerAddress },
      {
        $set: {
          settlementState: "Refunded",
          refundedAt: now,
          refundTransactionHash: event.transactionHash || event.txHash || null,
          indexedLedger: event.ledger || null,
          updatedAt: now,
        },
      },
      options
    );

    await invalidateEntitlement(event.materialId, buyerAddress, "chain-refunded", {
      db,
      session,
      purchaseId: event.purchaseId,
      settlementState: "Refunded",
    });
  }

  if (event.type === "dispute.opened") {
    const purchase = await db.collection(COLLECTIONS.purchases).findOne(
      {
        materialId: event.materialId,
        purchaseId: event.purchaseId,
      },
      options
    );
    if (isStaleReplay(purchase, event)) {
      return { eventId: id, skipped: true };
    }
    const buyerAddress = purchase?.buyerAddress || null;

    await db.collection(COLLECTIONS.purchases).updateOne(
      { materialId: event.materialId, purchaseId: event.purchaseId },
      {
        $set: {
          settlementState: "Disputed",
          disputedAt: now,
          indexedLedger: event.ledger || null,
          updatedAt: now,
        },
      },
      options
    );

    if (buyerAddress) {
      await invalidateEntitlement(event.materialId, buyerAddress, "chain-disputed", {
        db,
        session,
        purchaseId: event.purchaseId,
        settlementState: "Disputed",
      });
    }
  }

  return { eventId: id, skipped: !!alreadyIndexed };
}

/**
 * True when `event` is older (by ledger sequence) than the ledger already
 * recorded against `record`, meaning applying it would move settlement
 * state backward in time. Records or events with no ledger information
 * (older data predating this field, or an event source that doesn't supply
 * one) are never treated as stale, since there's nothing reliable to
 * compare.
 */
function isStaleReplay(record, event) {
  if (!record || !record.indexedLedger || !event.ledger) return false;
  return event.ledger < record.indexedLedger;
}

export async function runIndexerBatch({
  db,
  eventSource,
  source = "stellar",
  limit = 100,
  getLedgerHash = null,
}) {
  const stateId = `${source}:events`;
  let state = await db.collection(COLLECTIONS.syncState).findOne({ _id: stateId });

  if (state?.lastLedger && state?.lastLedgerHash && getLedgerHash) {
    const fork = await detectFork(db, {
      ledger: state.lastLedger,
      expectedHash: state.lastLedgerHash,
      getLedgerHash,
    });
    if (fork.forked) {
      await rewindAfterFork(db, { source, divergenceLedger: state.lastLedger });
      state = await db.collection(COLLECTIONS.syncState).findOne({ _id: stateId });
    }
  }

  const batch = await eventSource.getEvents({ cursor: state?.cursor || null, limit });
  const events = batch.events || [];
  let applied = 0;
  let skipped = 0;
  let hadFailure = false;
  let lastSuccessfulCursor = state?.cursor || null;
  let lastSuccessfulLedger = state?.lastLedger || null;

  const maxRetries = Number(process.env.INDEXER_MAX_RETRIES || 3);

  for (const event of events) {
    const parsedEvent = parseContractEvent(event) || (event?.type ? event : null);
    if (!parsedEvent) {
      skipped += 1;
      lastSuccessfulCursor = event.id ?? event.pagingToken ?? lastSuccessfulCursor;
      lastSuccessfulLedger = event.ledger ?? lastSuccessfulLedger;
      continue;
    }

    try {
      const result = await applyIndexedEvent(db, { ...parsedEvent, source });
      if (result.skipped) skipped += 1;
      else applied += 1;

      if (result.eventId) {
        await db.collection(COLLECTIONS.deadLetterEvents).deleteOne({ _id: result.eventId }).catch(() => {});
      }

      lastSuccessfulCursor = event.id ?? event.pagingToken ?? lastSuccessfulCursor;
      lastSuccessfulLedger = parsedEvent.ledger ?? lastSuccessfulLedger;
    } catch (err) {
      hadFailure = true;
      const id = eventId(parsedEvent) || eventId(event) || `${source}:unknown:${event.ledger || "?"}:${event.id || event.pagingToken || Math.random().toString(36).slice(2, 8)}`;
      const dlCol = db.collection(COLLECTIONS.deadLetterEvents);
      const existing = await dlCol.findOne({ _id: id });
      const retryCount = (existing?.retryCount || 0) + 1;
      const classification = classifyIndexerError(err);
      const status = classification === "poison" || retryCount > maxRetries ? "failed" : "retryable";
      await dlCol.updateOne(
        { _id: id },
        {
          $set: {
            raw: event,
            parsed: parsedEvent,
            lastError: String(err?.message || err),
            errorClass: classification,
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

  const nextCursor = hadFailure ? lastSuccessfulCursor : batch.nextCursor || lastSuccessfulCursor;
  const nextLedger = hadFailure ? lastSuccessfulLedger : batch.lastLedger || lastSuccessfulLedger;

  let nextLedgerHash = state?.lastLedgerHash || null;
  if (getLedgerHash && nextLedger && nextLedger !== state?.lastLedger) {
    const canonical = await getLedgerHash(nextLedger).catch(() => null);
    nextLedgerHash = canonical?.hash || nextLedgerHash;
  }

  await db.collection(COLLECTIONS.syncState).updateOne(
    { _id: stateId },
    {
      $set: {
        _id: stateId,
        source,
        cursor: nextCursor,
        lastLedger: nextLedger,
        lastLedgerHash: nextLedgerHash,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  return { applied, skipped, nextCursor, hadFailure };
}

/**
 * Point-in-time indexer health metrics (#469 & #631).
 * Reports lag, checkpoint generation, dead letter counts, and blocked events.
 *
 * @param {import('mongodb').Db} db
 * @param {{ source?: string, currentLedger?: number }} [opts]
 */
export async function getIndexerHealth(db, { source = "stellar", currentLedger = null } = {}) {
  const state = await db.collection(COLLECTIONS.syncState).findOne({ _id: `${source}:events` });
  const dlCol = db.collection(COLLECTIONS.deadLetterEvents);

  let retryable = [];
  let failed = [];

  if (typeof dlCol.find === "function") {
    [retryable, failed] = await Promise.all([
      dlCol.find({ status: "retryable" }).toArray(),
      dlCol.find({ status: "failed" }).toArray(),
    ]);
  } else if (dlCol.records instanceof Map) {
    const records = Array.from(dlCol.records.values());
    retryable = records.filter((d) => d.status === "retryable");
    failed = records.filter((d) => d.status === "failed");
  }

  const lastLedger = state?.lastLedger ?? null;
  const blockedEventsCount = retryable.length + failed.length;

  return {
    source,
    lastLedger,
    lastLedgerHash: state?.lastLedgerHash ?? null,
    lastCheckpointAt: state?.updatedAt ?? null,
    lag: currentLedger != null && lastLedger != null ? Math.max(0, currentLedger - lastLedger) : null,
    deadLetterRetryableCount: retryable.length,
    deadLetterFailedCount: failed.length,
    deadLetterRetrySum: retryable.reduce((sum, d) => sum + (d.retryCount || 0), 0),
    blockedEventsCount,
    lastForkRewindAt: state?.lastForkRewindAt ?? null,
    lastForkDivergenceLedger: state?.lastForkDivergenceLedger ?? null,
  };
}

export function createJsonRpcEventSource({ rpcUrl, contractId, fetchImpl = fetch }) {
  const contractIds = Array.isArray(contractId)
    ? contractId.filter(Boolean)
    : contractId
      ? [contractId]
      : [];

  return {
    async getEvents({ cursor, limit }) {
      const response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getEvents",
          params: {
            filters: contractIds.length > 0 ? [{ contractIds }] : [],
            pagination: { cursor, limit },
          },
        }),
      });
      const payload = await response.json();
      if (payload.error) {
        throw new Error(payload.error.message || "Stellar RPC getEvents failed");
      }

      return {
        events: payload.result?.events || [],
        nextCursor: payload.result?.cursor || null,
        lastLedger: payload.result?.latestLedger || null,
      };
    },
  };
}

export async function reprocessDeadLetters(db, { statuses = ['retryable', 'failed'], limit = 100 } = {}) {
  const dlCol = db.collection(COLLECTIONS.deadLetterEvents);
  const items = [];

  if (typeof dlCol.find === 'function') {
    const cursor = dlCol.find({ status: { $in: statuses } }).limit(limit);
    for await (const doc of cursor) items.push(doc);
  } else {
    const records = dlCol.records instanceof Map ? Array.from(dlCol.records.values()) : [];
    for (const r of records) if (statuses.includes(r.status)) items.push(r);
  }

  const reprocessed = [];
  for (const entry of items.slice(0, limit)) {
    // Dead-letter rows store the *raw* Soroban RPC event, but
    // `applyIndexedEvent` expects the parsed shape (with a `type` field) —
    // previously this fed `entry.raw` straight into `applyIndexedEvent`
    // without parsing it first, so every field-based `if (event.type ===
    // ...)` branch silently matched nothing and reprocessing was a no-op
    // that still reported success (#469). Prefer `entry.parsed` (recorded
    // alongside `raw` for entries created after this fix); fall back to
    // parsing `entry.raw` for older entries that predate it.
    const parsedEvent = entry.parsed || parseContractEvent(entry.raw);
    if (!parsedEvent) {
      // Still undecodable — this is a poison event, not a reprocessing bug.
      // Leave it in the dead-letter collection rather than looping forever.
      await dlCol.updateOne(
        { _id: entry._id },
        { $set: { status: 'failed', lastError: 'Event could not be parsed on reprocess', lastAttemptedAt: new Date() } }
      );
      continue;
    }
    const eventToApply = { ...parsedEvent, source: entry.source || parsedEvent.source };

    try {
      await applyIndexedEvent(db, eventToApply);
      await dlCol.deleteOne({ _id: entry._id });
      reprocessed.push({ id: entry._id });
    } catch (err) {
      // attempt one more immediate retry (helps transient failures during reprocess)
      try {
        await applyIndexedEvent(db, eventToApply);
        await dlCol.deleteOne({ _id: entry._id });
        reprocessed.push({ id: entry._id });
        continue;
      } catch (err2) {
        await dlCol.updateOne({ _id: entry._id }, { $set: { lastError: String(err2?.message || err2), lastAttemptedAt: new Date() } }, { upsert: true });
      }
    }
  }

  return { reprocessed };
}
