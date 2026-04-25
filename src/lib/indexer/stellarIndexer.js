import { COLLECTIONS } from "../backend/schemaContracts.js";

function duplicateKey(error) {
  return error?.code === 11000;
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

export async function applyIndexedEvent(db, event, { now = new Date() } = {}) {
  const id = eventId(event);
  if (!id) {
    throw new Error("Indexed event is missing a stable id");
  }

  try {
    await db.collection(COLLECTIONS.syncEvents).insertOne({
      _id: id,
      type: event.type,
      source: event.source || "stellar",
      raw: event,
      createdAt: now,
    });
  } catch (error) {
    if (duplicateKey(error)) {
      return { eventId: id, skipped: true };
    }
    throw error;
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
      { upsert: true }
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
      { upsert: true }
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
      { upsert: true }
    );
  }

  return { eventId: id, skipped: false };
}

export async function runIndexerBatch({ db, eventSource, source = "stellar", limit = 100 }) {
  const stateId = `${source}:events`;
  const state = await db.collection(COLLECTIONS.syncState).findOne({ _id: stateId });
  const batch = await eventSource.getEvents({ cursor: state?.cursor || null, limit });
  const events = batch.events || [];
  let applied = 0;
  let skipped = 0;

  for (const event of events) {
    const result = await applyIndexedEvent(db, { ...event, source });
    if (result.skipped) skipped += 1;
    else applied += 1;
  }

  await db.collection(COLLECTIONS.syncState).updateOne(
    { _id: stateId },
    {
      $set: {
        _id: stateId,
        source,
        cursor: batch.nextCursor || state?.cursor || null,
        lastLedger: batch.lastLedger || state?.lastLedger || null,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  return { applied, skipped, nextCursor: batch.nextCursor || null };
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
