import { COLLECTIONS } from "../backend/schemaContracts.js";
import { parseContractEvent } from "./eventParser.js";
import { invalidateEntitlement } from "../entitlement.js";
import { detectFork, rewindAfterFork, dedupeCheckpoints, MAX_CHECKPOINTS } from "./forkDetection.js";
import { deriveEventIdFromEvent, computeQuarantineKey } from "./eventIdentity.js";

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
  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === 11600 ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN"
  ) {
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
    message.includes("topology was destroyed") ||
    message.includes("fetch failed") ||
    message.includes("failed to fetch") ||
    message.includes("dns") ||
    message.includes("getaddrinfo")
  ) {
    return "transient";
  }
  // Validation errors, decode failures, missing-id errors, and anything else
  // unrecognized are treated as poison: retrying without operator
  // intervention won't change the outcome.
  return "poison";
}

/**
 * Derive a stable id for `event` (#630). Delegates to `deriveEventIdFromEvent`,
 * which is deterministic and never invents a random fallback — an event that
 * can't be identified returns an empty string here, so the existing
 * `if (!id) throw ...` contract in `applyIndexedEvent` keeps working unchanged.
 * `runIndexerBatch` pre-checks sufficiency itself so a live-indexed event that
 * can't be identified is quarantined before it ever reaches that throw.
 */
export function eventId(event) {
  return deriveEventIdFromEvent(event).id || "";
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
    const purchaseSnapshot = {
      metadataHash: event.metadataHash || null,
      rightsHash: event.rightsHash || null,
      saleTermsVersion: event.saleTermsVersion ?? null,
      metadataUri: event.metadataUri || null,
    };
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
          purchaseSnapshot,
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

  if (event.type === "dispute.resolved") {
    const purchase = await db.collection(COLLECTIONS.purchases).findOne(
      { materialId: event.materialId, purchaseId: event.purchaseId },
      options
    );
    if (isStaleReplay(purchase, event)) {
      return { eventId: id, skipped: true };
    }
    const buyerAddress = purchase?.buyerAddress || null;
    const refundedBuyer = event.resolution === "RefundBuyer";

    await db.collection(COLLECTIONS.purchases).updateOne(
      { materialId: event.materialId, purchaseId: event.purchaseId },
      {
        $set: {
          settlementState: refundedBuyer ? "Refunded" : "Released",
          disputeResolution: event.resolution ?? null,
          disputeResolvedAt: now,
          disputeResolvedLedger: event.resolvedLedger ?? null,
          indexedLedger: event.ledger || null,
          updatedAt: now,
        },
      },
      options
    );

    if (refundedBuyer) {
      // Mirror purchase.refunded: a RefundBuyer resolution revokes the
      // cached entitlement for this (materialId, buyer) pair.
      if (buyerAddress) {
        await invalidateEntitlement(event.materialId, buyerAddress, "chain-dispute-resolved", {
          db,
          session,
          purchaseId: event.purchaseId,
          settlementState: "Refunded",
        });
      }
    } else if (buyerAddress) {
      // ReleaseToCreator keeps the buyer's access active — re-establish the
      // entitlement that dispute.opened froze.
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
            settlementState: "Released",
            chainTxHash: event.transactionHash || event.txHash || null,
            indexedLedger: event.ledger || null,
            checkedAt: now,
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        upsertOptions
      );
    }
  }

  if (event.type === "escrow.released") {
    const purchase = await db.collection(COLLECTIONS.purchases).findOne(
      { materialId: event.materialId, purchaseId: event.purchaseId },
      options
    );
    if (isStaleReplay(purchase, event)) {
      return { eventId: id, skipped: true };
    }

    await db.collection(COLLECTIONS.purchases).updateOne(
      { materialId: event.materialId, purchaseId: event.purchaseId },
      {
        $set: {
          settlementState: "Released",
          escrowReleasedAt: now,
          escrowReleaseLedger: event.ledger || null,
          indexedLedger: event.ledger || null,
          updatedAt: now,
        },
      },
      options
    );
  }

  if (event.type === "payout.distributed") {
    const recipientAddress = String(event.recipient || "").toLowerCase();
    await db.collection(COLLECTIONS.payouts).updateOne(
      { purchaseId: event.purchaseId, recipient: recipientAddress },
      {
        $set: {
          purchaseId: event.purchaseId ?? null,
          materialId: event.materialId || null,
          recipient: recipientAddress,
          role: event.role ?? null,
          asset: event.asset ?? null,
          amount: event.amount ?? null,
          chainTxHash: event.transactionHash || event.txHash || null,
          indexedLedger: event.ledger || null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      upsertOptions
    );
  }

  if (event.type === "purchase.bulk_completed") {
    const bulkKey = `bulk:${event.transactionHash || event.txHash || "tx"}:${event.materialId}`;
    await db.collection(COLLECTIONS.bulkPurchases).updateOne(
      { _id: bulkKey },
      {
        $set: {
          _id: bulkKey,
          purchaser: event.purchaser ?? null,
          materialId: event.materialId || null,
          recipientCount: event.recipientCount ?? null,
          unitPrice: event.unitPrice ?? null,
          totalPaid: event.totalPaid ?? null,
          asset: event.asset ?? null,
          chainTxHash: event.transactionHash || event.txHash || null,
          indexedLedger: event.ledger || null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      upsertOptions
    );
  }

  if (event.type === "creator.tier_updated") {
    const creatorKey = String(event.creator || "").toLowerCase();
    await db.collection(COLLECTIONS.creatorTiers).updateOne(
      { _id: creatorKey },
      {
        $set: {
          _id: creatorKey,
          creator: event.creator ?? null,
          tier: event.tier ?? null,
          indexedLedger: event.ledger || null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      upsertOptions
    );
  }

  if (event.type === "admin.transfer_initiated") {
    const fromKey = String(event.from || "").toLowerCase();
    await db.collection(COLLECTIONS.adminTransfers).updateOne(
      { _id: fromKey },
      {
        $set: {
          _id: fromKey,
          from: event.from ?? null,
          pendingAdmin: event.pendingAdmin ?? null,
          status: "initiated",
          indexedLedger: event.ledger || null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      upsertOptions
    );
  }

  if (event.type === "admin.transfer_accepted") {
    const newAdminKey = String(event.newAdmin || "").toLowerCase();
    await db.collection(COLLECTIONS.adminTransfers).updateOne(
      { _id: newAdminKey },
      {
        $set: {
          _id: newAdminKey,
          newAdmin: event.newAdmin ?? null,
          status: "accepted",
          acceptedAt: now,
          indexedLedger: event.ledger || null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      upsertOptions
    );
  }

  // Scholarship credit subsystem — mirrors on-chain grant/redemption state
  // off-chain so moderators and analytics have visibility (see #598).
  if (event.type === "scholarship.credits_issued") {
    const learnerAddress = String(event.learner || "").toLowerCase();
    await db.collection(COLLECTIONS.scholarshipGrants).updateOne(
      { grantId: event.grantId, learner: learnerAddress },
      {
        $set: {
          grantId: event.grantId ?? null,
          learner: learnerAddress,
          issuer: event.issuer ?? null,
          amount: event.amount ?? null,
          remainingAmount: event.amount ?? null,
          expiresAt: event.expiresAt ?? null,
          active: true,
          indexedLedger: event.ledger || null,
          chainTxHash: event.transactionHash || event.txHash || null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      upsertOptions
    );
  }

  if (event.type === "scholarship.credits_redeemed") {
    const learnerAddress = String(event.learner || "").toLowerCase();
    await db.collection(COLLECTIONS.scholarshipRedemptions).updateOne(
      { redemptionId: event.redemptionId },
      {
        $set: {
          redemptionId: event.redemptionId ?? null,
          learner: learnerAddress,
          materialId: event.materialId || null,
          creditsUsed: event.creditsUsed ?? null,
          remainingCredits: event.remainingCredits ?? null,
          indexedLedger: event.ledger || null,
          chainTxHash: event.transactionHash || event.txHash || null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      upsertOptions
    );

    // Keep the learner's active grant's remaining balance in sync.
    await db.collection(COLLECTIONS.scholarshipGrants).updateOne(
      { learner: learnerAddress, active: true },
      {
        $set: {
          remainingAmount: event.remainingCredits ?? null,
          updatedAt: now,
        },
      },
      options
    );
  }

  if (event.type === "scholarship.grant_revoked") {
    const learnerAddress = String(event.learner || "").toLowerCase();
    await db.collection(COLLECTIONS.scholarshipGrants).updateOne(
      { grantId: event.grantId, learner: learnerAddress },
      {
        $set: {
          active: false,
          creditsRevoked: event.creditsRevoked ?? null,
          revokedAt: now,
          indexedLedger: event.ledger || null,
          updatedAt: now,
        },
      },
      options
    );
  }

  if (event.type === "scholarship.cost_updated") {
    await db.collection(COLLECTIONS.materials).updateOne(
      { materialId: event.materialId },
      {
        $set: {
          materialId: event.materialId,
          scholarshipCreditCost: event.creditCost ?? null,
          indexedLedger: event.ledger || null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      upsertOptions
    );
  }

  if (event.type === "scholarship.issuer_updated") {
    await db.collection(COLLECTIONS.scholarshipConfig).updateOne(
      { _id: "issuer" },
      {
        $set: {
          _id: "issuer",
          issuer: event.issuer ?? null,
          enabled: event.enabled !== false,
          indexedLedger: event.ledger || null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      upsertOptions
    );
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

/**
 * Record an event whose identity `deriveEventIdFromEvent` could not trust
 * enough to apply (#630) — reject it into quarantine rather than processing it
 * under a fabricated id. Never throws: a failure to write the quarantine
 * record itself must not stall the batch (the event is skipped either way, and
 * the batch result's `quarantined` count plus the indexer log still record
 * that something was rejected).
 *
 * Time/space: O(1) writes; the dedup key is one hash of the raw event, so a
 * replay of the same rejected event upserts the same row (see
 * `computeQuarantineKey`).
 */
async function quarantineEvent(db, { raw, parsed, reason, source, now }) {
  const key = computeQuarantineKey({ source, rawEvent: raw });

  try {
    await db.collection(COLLECTIONS.indexerQuarantine).updateOne(
      { _id: key },
      {
        $set: {
          source,
          type: parsed?.type || raw?.type || null,
          raw,
          parsed,
          reason,
          status: "pending",
          lastSeenAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  } catch {
    // Best-effort — see doc comment above.
  }
}

export async function runIndexerBatch({
  db,
  eventSource,
  source = "stellar",
  limit = 100,
  getLedgerHash = null,
  network = null,
}) {
  const stateId = `${source}:events`;
  let state = await db.collection(COLLECTIONS.syncState).findOne({ _id: stateId });

  if (state?.lastLedger && state?.lastLedgerHash && getLedgerHash) {
    const fork = await detectFork(db, {
      // Prefer the bounded per-ledger checkpoint history when present; fall
      // back to a single-entry history derived from the legacy fields.
      checkpoints: Array.isArray(state?.checkpoints) && state.checkpoints.length > 0
        ? state.checkpoints
        : [{ ledger: state.lastLedger, hash: state.lastLedgerHash }],
      ledger: state.lastLedger,
      expectedHash: state.lastLedgerHash,
      getLedgerHash,
    });
    if (fork.forked) {
      await rewindAfterFork(db, { source, divergenceLedger: fork.divergenceLedger });
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
  let quarantined = 0;

  for (const event of events) {
    const parsedEvent = parseContractEvent(event) || (event?.type ? event : null);
    if (!parsedEvent) {
      skipped += 1;
      lastSuccessfulCursor = event.id ?? event.pagingToken ?? lastSuccessfulCursor;
      lastSuccessfulLedger = event.ledger ?? lastSuccessfulLedger;
      continue;
    }

    // #630: identity is derived once, up front, from the event's own
    // canonical position (network + contract + ledger + transaction +
    // operation index + event position) — never from a random number. An
    // event that can't produce a trustworthy id this way is rejected into
    // quarantine instead of being processed: it is never applied, so it can
    // never double-apply a purchase or settlement no matter how many times
    // the batch is retried.
    const eventWithContext = { ...parsedEvent, source, network };
    const identity = deriveEventIdFromEvent(eventWithContext);

    if (!identity.sufficient) {
      quarantined += 1;
      await quarantineEvent(db, { raw: event, parsed: parsedEvent, reason: identity.reason, source, now: new Date() });
      lastSuccessfulCursor = event.id ?? event.pagingToken ?? lastSuccessfulCursor;
      lastSuccessfulLedger = event.ledger ?? lastSuccessfulLedger;
      continue;
    }

    try {
      const result = await applyIndexedEvent(db, eventWithContext);
      if (result.skipped) skipped += 1;
      else applied += 1;

      if (result.eventId) {
        await db.collection(COLLECTIONS.deadLetterEvents).deleteOne({ _id: result.eventId }).catch(() => {});
      }

      lastSuccessfulCursor = event.id ?? event.pagingToken ?? lastSuccessfulCursor;
      lastSuccessfulLedger = parsedEvent.ledger ?? lastSuccessfulLedger;
    } catch (err) {
      hadFailure = true;
      const id = identity.id;
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

  // Maintain the bounded per-ledger checkpoint history used for deep reorg
  // detection (#587): append the new checkpoint (when the batch advanced to
  // a ledger we can hash), dedupe by ledger keeping the newest hash, and trim
  // to MAX_CHECKPOINTS entries.
  const existingCheckpoints =
    Array.isArray(state?.checkpoints) && state.checkpoints.length > 0
      ? state.checkpoints
      : state?.lastLedger && state?.lastLedgerHash
        ? [{ ledger: state.lastLedger, hash: state.lastLedgerHash }]
        : [];

  const nextCheckpoints = [...existingCheckpoints];
  if (nextLedger && nextLedgerHash && nextLedger !== state?.lastLedger) {
    nextCheckpoints.push({ ledger: nextLedger, hash: nextLedgerHash });
  }

  const boundedCheckpoints = dedupeCheckpoints(nextCheckpoints).slice(-MAX_CHECKPOINTS);

  await db.collection(COLLECTIONS.syncState).updateOne(
    { _id: stateId },
    {
      $set: {
        _id: stateId,
        source,
        cursor: nextCursor,
        lastLedger: nextLedger,
        lastLedgerHash: nextLedgerHash,
        checkpoints: boundedCheckpoints,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  return { applied, skipped, quarantined, nextCursor, hadFailure };
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

  // #630: events rejected into quarantine (insufficiently identified — see
  // eventIdentity.js) are a separate bucket from dead-lettered events (which
  // failed to *apply*, not to be *identified*), surfaced here so an operator
  // backlog of either is visible from the same health check. Counted
  // server-side — the rows themselves are never pulled into memory.
  const qCol = db.collection(COLLECTIONS.indexerQuarantine);
  let quarantinedCount = 0;
  if (typeof qCol.countDocuments === "function") {
    quarantinedCount = await qCol.countDocuments({ status: "pending" });
  } else if (typeof qCol.find === "function") {
    quarantinedCount = (await qCol.find({ status: "pending" }).toArray()).length;
  } else if (qCol.records instanceof Map) {
    quarantinedCount = Array.from(qCol.records.values()).filter((d) => d.status === "pending").length;
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
    quarantinedCount,
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

export async function reprocessDeadLetters(db, { statuses = ['retryable', 'failed'], limit = 100, network = null } = {}) {
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
    // #630: carry the network through so a reprocessed event derives the same
    // canonical id the live indexer would, keeping projection exactly-once.
    const eventToApply = { ...parsedEvent, source: entry.source || parsedEvent.source, network: parsedEvent.network ?? network };

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

async function recordIndexerOperatorAction(db, action) {
  await db.collection(COLLECTIONS.indexerOperatorAudit).insertOne({
    ...action,
    createdAt: new Date(),
  });
}

export async function listDeadLetterEvents(db, { status, limit = 50 } = {}) {
  const query = status ? { status } : {};
  const dlCol = db.collection(COLLECTIONS.deadLetterEvents);
  if (typeof dlCol.find !== 'function') {
    const records = dlCol.records instanceof Map ? Array.from(dlCol.records.values()) : [];
    return records.filter((entry) => (status ? entry.status === status : true)).slice(0, limit);
  }
  return dlCol.find(query).sort({ lastAttemptedAt: -1 }).limit(limit).toArray();
}

export async function retryDeadLetter(db, eventId, { operator = 'system' } = {}) {
  const dlCol = db.collection(COLLECTIONS.deadLetterEvents);
  const entry = await dlCol.findOne({ _id: eventId });
  if (!entry) {
    throw new Error(`Dead-letter event not found: ${eventId}`);
  }
  if (entry.status === 'quarantined') {
    throw new Error('Quarantined events must be explicitly released before retry');
  }

  const parsedEvent = entry.parsed || parseContractEvent(entry.raw);
  if (!parsedEvent) {
    throw new Error('Event could not be parsed for retry');
  }

  await applyIndexedEvent(db, { ...parsedEvent, source: entry.source || parsedEvent.source });
  await dlCol.deleteOne({ _id: eventId });
  await recordIndexerOperatorAction(db, {
    eventId,
    action: 'retry',
    operator,
    previousStatus: entry.status,
    errorClass: entry.errorClass || null,
  });
  return { eventId, retried: true };
}

export async function quarantineDeadLetter(db, eventId, { reason, operator = 'system' } = {}) {
  if (!reason || !String(reason).trim()) {
    throw new Error('Permanent failures require an explicit quarantine reason');
  }

  const dlCol = db.collection(COLLECTIONS.deadLetterEvents);
  const entry = await dlCol.findOne({ _id: eventId });
  if (!entry) {
    throw new Error(`Dead-letter event not found: ${eventId}`);
  }

  await dlCol.updateOne(
    { _id: eventId },
    {
      $set: {
        status: 'quarantined',
        quarantineReason: String(reason).trim(),
        quarantinedAt: new Date(),
        quarantinedBy: operator,
        lastAttemptedAt: new Date(),
      },
    }
  );

  await recordIndexerOperatorAction(db, {
    eventId,
    action: 'quarantine',
    operator,
    reason: String(reason).trim(),
    previousStatus: entry.status,
    errorClass: entry.errorClass || null,
  });

  return { eventId, quarantined: true };
}
