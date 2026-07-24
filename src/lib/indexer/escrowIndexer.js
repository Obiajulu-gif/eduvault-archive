import { COLLECTIONS } from "../backend/schemaContracts.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { logger } from "../logger.js";
import { eventId, deadLetterId } from "./stellarIndexer.js";

function duplicateKey(error) {
  return error?.code === 11000;
}

function transactionsUnsupported(error) {
  if (error?.codeName === "IllegalOperation" || error?.code === 20) return true;
  return /Transaction numbers are only allowed on a replica set member or mongos/i.test(
    String(error?.message || ""),
  );
}

let transactionSupport = "unknown";

function writeOptions(session, extra = {}) {
  return session ? { ...extra, session } : extra;
}

async function applyEscrowEventStateMachine(db, event, { now, session }) {
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
      source: event.source || "escrow",
      network: event.network || event.source || "escrow",
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

  if (event.type === "escrow.funded") {
    await db.collection(COLLECTIONS.escrows).updateOne(
      { escrowId: event.escrowId },
      {
        $set: {
          escrowId: event.escrowId,
          contractId: event.contractId || null,
          engager: event.engager,
          amount: event.amount,
          asset: event.asset,
          status: "funded",
          chainTxHash: event.transactionHash || event.txHash || null,
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
        },
      },
      writeOptions(session, { upsert: true })
    );
  }

  if (event.type === "escrow.released") {
    await db.collection(COLLECTIONS.escrows).updateOne(
      { escrowId: event.escrowId },
      {
        $set: {
          status: "released",
          updatedAt: now,
        },
      },
      writeOptions(session)
    );
    // Project payout creation
    await db.collection(COLLECTIONS.payouts).updateOne(
      { payoutId: `${event.escrowId}-${event.recipient}` },
      {
        $set: {
          payoutId: `${event.escrowId}-${event.recipient}`,
          escrowId: event.escrowId,
          recipient: event.recipient,
          amount: event.amount,
          status: "claimed",
          chainTxHash: event.transactionHash || event.txHash || null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      writeOptions(session, { upsert: true })
    );
  }

  if (event.type === "escrow.refunded") {
    await db.collection(COLLECTIONS.escrows).updateOne(
      { escrowId: event.escrowId },
      {
        $set: {
          status: "refunded",
          updatedAt: now,
        },
      },
      writeOptions(session)
    );
  }

  if (event.type === "escrow.disputed") {
    await db.collection(COLLECTIONS.escrows).updateOne(
      { escrowId: event.escrowId },
      {
        $set: {
          status: "disputed",
          updatedAt: now,
        },
      },
      writeOptions(session)
    );
  }

  if (event.type === "milestone.approved") {
    await db.collection(COLLECTIONS.milestones).updateOne(
      { milestoneId: String(event.milestoneId), escrowId: event.escrowId },
      {
        $set: {
          milestoneId: String(event.milestoneId),
          escrowId: event.escrowId,
          status: "approved",
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

export async function applyEscrowEvent(db, event, { now = new Date() } = {}) {
  const client = db.client;
  if (!client || typeof client.startSession !== "function" || transactionSupport === "unavailable") {
    return applyEscrowEventStateMachine(db, event, { now, session: null });
  }

  const session = client.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await applyEscrowEventStateMachine(db, event, { now, session });
    });
    transactionSupport = "available";
    return result;
  } catch (error) {
    if (!transactionsUnsupported(error)) throw error;

    transactionSupport = "unavailable";
    logger.warn(
      { reason: error?.message },
      "[EscrowIndexer] Mongo transactions unavailable; falling back to non-transactional writes",
    );
    incrementCounter("indexer_transaction_fallback_total", { source: event.source || "escrow" });
    return applyEscrowEventStateMachine(db, event, { now, session: null });
  } finally {
    await session.endSession();
  }
}
