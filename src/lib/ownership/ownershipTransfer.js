import crypto from "node:crypto";
import { AppError } from "../errors/AppError.js";

// Safe material ownership transfer. Ownership never moves on one party's say-so:
// the owner proposes, the recipient accepts, and a proposal that nobody answers
// expires. See docs/ownership-transfer.md for the state machine and recovery.
//
// A transfer touches two documents (the transfer and the material) and Mongo
// gives us no multi-document transaction here, so `accepting` is an explicit
// intermediate state with a lease. Whatever dies mid-accept, recoverStuckTransfers
// can tell from the material's owner which way to settle it.

export const OWNERSHIP_TRANSFERS_COLLECTION = "ownership_transfers";
export const OWNERSHIP_DISPUTES_COLLECTION = "ownership_transfer_disputes";

export const TransferState = Object.freeze({
  PENDING: "pending",
  ACCEPTING: "accepting",
  ACCEPTED: "accepted",
  DECLINED: "declined",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  FAILED: "failed",
});

export const DisputeState = Object.freeze({
  OPEN: "open",
  UNDER_REVIEW: "under_review",
  RESOLVED_ACCEPTED: "resolved_accepted",
  RESOLVED_REJECTED: "resolved_rejected",
});

export const DEFAULT_TRANSFER_TTL_MS = 72 * 60 * 60 * 1000;
export const MIN_TRANSFER_TTL_MS = 60 * 60 * 1000;
export const MAX_TRANSFER_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// How long an `accepting` claim blocks other attempts before recovery may settle it.
export const ACCEPT_LEASE_MS = 2 * 60 * 1000;

// Materials in these states cannot change hands: a takedown or fraud hold must
// not be laundered through a new owner.
const NON_TRANSFERABLE_STATUSES = new Set(["suspended", "quarantined", "deleted"]);

const MAX_REASON_LENGTH = 500;

function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function requireAddress(value, field) {
  if (typeof value !== "string" || value.trim().length < 3 || value.length > 128) {
    throw new AppError("VALIDATION_FIELD", { message: `${field} is required.`, details: { field } });
  }
  return value.trim();
}

function unwrap(result) {
  return result?.value ?? result ?? null;
}

function historyEntry(action, actor, now, extra = {}) {
  return { action, actor, at: now, ...extra };
}

// `userAddress` is the canonical owner field. Legacy rows that only carry
// `ownerAddress` are not transferable until repaired, so the owner swap below
// can match on one exact stored value.
function ownerOf(material) {
  return material?.userAddress || null;
}

function restrictedReason(material) {
  if (material.isDeleted) return "material_deleted";
  const status = material.status || material.moderationStatus || material.visibility;
  return NON_TRANSFERABLE_STATUSES.has(status) ? `material_${status}` : null;
}

function isDuplicateKey(error) {
  return error?.code === 11000;
}

function transfers(db) {
  return db.collection(OWNERSHIP_TRANSFERS_COLLECTION);
}

function disputes(db) { return db.collection(OWNERSHIP_DISPUTES_COLLECTION); }
function disputeActorId(actor) { return String(actor?.id ?? actor?.sub ?? actor?.walletAddress ?? actor); }

export async function openTransferDispute(db, { transferId, actor, reason, evidence = [], now = new Date() } = {}) {
  const transfer = await loadTransfer(db, transferId);
  const actorId = disputeActorId(actor);
  if (![transfer.fromAddress, transfer.toAddress].some((address) => sameAddress(address, actorId)) && actor?.role !== "admin") {
    throw new AppError("AUTH_FORBIDDEN", { message: "Only a transfer party or admin may open a dispute." });
  }
  if (!reason || String(reason).trim().length < 3) throw new AppError("VALIDATION_FIELD", { message: "A dispute reason is required." });
  if (![TransferState.PENDING, TransferState.ACCEPTING, TransferState.ACCEPTED].includes(transfer.state)) throw new AppError("CONFLICT_STATE", { message: "Only live or completed transfers can be disputed." });
  const existing = await disputes(db).findOne({ transferId, state: { $in: [DisputeState.OPEN, DisputeState.UNDER_REVIEW] } });
  if (existing) return { dispute: existing, replayed: true };
  const at = now instanceof Date ? now : new Date(now);
  const dispute = { _id: crypto.randomUUID(), transferId, state: DisputeState.OPEN, openedBy: actorId, reason: String(reason).trim().slice(0, MAX_REASON_LENGTH), evidence: normalizeEvidence(evidence), history: [{ action: "opened", actor: actorId, at }], createdAt: at, updatedAt: at };
  await disputes(db).insertOne(dispute);
  return { dispute, replayed: false };
}

function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence)) throw new AppError("VALIDATION_FIELD", { message: "Evidence must be an array." });
  return evidence.slice(0, 50).map((item) => ({ type: String(item?.type || "reference").slice(0, 40), reference: String(item?.reference || "").slice(0, 500), description: String(item?.description || "").slice(0, 500) })).filter((item) => item.reference);
}

export async function addDisputeEvidence(db, { disputeId, actor, evidence, now = new Date() } = {}) {
  const dispute = await disputes(db).findOne({ _id: disputeId });
  if (!dispute) throw new AppError("NOT_FOUND", { message: "Ownership transfer dispute not found." });
  if (![DisputeState.OPEN, DisputeState.UNDER_REVIEW].includes(dispute.state)) throw new AppError("CONFLICT_STATE", { message: "Resolved disputes cannot receive evidence." });
  const at = now instanceof Date ? now : new Date(now);
  const item = normalizeEvidence([evidence])[0];
  if (!item) throw new AppError("VALIDATION_FIELD", { message: "Evidence reference is required." });
  const result = await disputes(db).findOneAndUpdate({ _id: disputeId }, { $push: { evidence: item, history: { action: "evidence_added", actor: disputeActorId(actor), at } }, $set: { updatedAt: at } }, { returnDocument: "after" });
  return result?.value ?? result;
}

export async function resolveTransferDispute(db, { disputeId, actor, resolution, reason, now = new Date() } = {}) {
  if (actor?.role !== "admin") throw new AppError("AUTH_FORBIDDEN", { message: "Only an admin may resolve ownership disputes." });
  if (![DisputeState.RESOLVED_ACCEPTED, DisputeState.RESOLVED_REJECTED].includes(resolution)) throw new AppError("VALIDATION_FIELD", { message: "Invalid dispute resolution." });
  const dispute = await disputes(db).findOne({ _id: disputeId });
  if (!dispute) throw new AppError("NOT_FOUND", { message: "Ownership transfer dispute not found." });
  if (![DisputeState.OPEN, DisputeState.UNDER_REVIEW].includes(dispute.state)) return { dispute, replayed: true };
  const at = now instanceof Date ? now : new Date(now);
  const result = await disputes(db).findOneAndUpdate({ _id: disputeId, state: { $in: [DisputeState.OPEN, DisputeState.UNDER_REVIEW] } }, { $set: { state: resolution, resolutionReason: String(reason || "").slice(0, MAX_REASON_LENGTH), resolvedBy: disputeActorId(actor), resolvedAt: at, updatedAt: at }, $push: { history: { action: resolution, actor: disputeActorId(actor), at } } }, { returnDocument: "after" });
  return { dispute: result?.value ?? result, replayed: false };
}

export async function assertTransferNotDisputed(db, transferId) {
  const dispute = await disputes(db).findOne({ transferId, state: { $in: [DisputeState.OPEN, DisputeState.UNDER_REVIEW] } });
  if (dispute) throw new AppError("CONFLICT_STATE", { message: "This transfer is on hold while an ownership dispute is reviewed.", details: { reason: "dispute_active", disputeId: dispute._id } });
}

/** Conditional state change; resolves to the updated transfer or null if it lost the race. */
async function transition(db, transferId, expectedStates, set, entry, extraFilter = {}) {
  const result = await transfers(db).findOneAndUpdate(
    { _id: transferId, state: { $in: expectedStates }, ...extraFilter },
    { $set: set, $push: { history: entry } },
    { returnDocument: "after" }
  );
  return unwrap(result);
}

async function loadTransfer(db, transferId) {
  if (typeof transferId !== "string" || !transferId) {
    throw new AppError("VALIDATION_FIELD", { message: "transferId is required.", details: { field: "transferId" } });
  }
  const transfer = await transfers(db).findOne({ _id: transferId });
  if (!transfer) throw new AppError("NOT_FOUND", { message: "Ownership transfer not found." });
  return transfer;
}

/** The recipient must be able to learn about a transfer, so unrelated callers get a 404, not a 403. */
function assertParty(transfer, actor, { allowed, admin = false }) {
  if (admin) return;
  const isFrom = sameAddress(transfer.fromAddress, actor);
  const isTo = sameAddress(transfer.toAddress, actor);
  if (!isFrom && !isTo) throw new AppError("NOT_FOUND", { message: "Ownership transfer not found." });
  if ((allowed === "to" && !isTo) || (allowed === "from" && !isFrom)) {
    throw new AppError("AUTH_FORBIDDEN", {
      message: "You are not allowed to perform this action on the transfer.",
      details: { reason: "wrong_party" },
    });
  }
}

function conflict(reason, transfer, message) {
  return new AppError("CONFLICT_STATE", {
    message,
    details: { reason, transferId: transfer._id, state: transfer.state },
  });
}

/** Lazily expire one overdue pending transfer so reads and writes never act on a dead offer. */
async function expireIfOverdue(db, transfer, now) {
  if (transfer.state !== TransferState.PENDING || transfer.expiresAt > now) return transfer;
  const expired = await transition(
    db,
    transfer._id,
    [TransferState.PENDING],
    { state: TransferState.EXPIRED, expiredAt: now },
    historyEntry("expired", "system", now)
  );
  return expired || (await transfers(db).findOne({ _id: transfer._id }));
}

/**
 * Owner proposes a transfer. Retrying the same proposal returns the live one.
 *
 * @returns {Promise<{transfer: object, replayed: boolean}>}
 */
export async function initiateTransfer(db, { materialId, actorAddress, toAddress, ttlMs, reason, now = new Date() }) {
  const from = requireAddress(actorAddress, "actorAddress");
  const to = requireAddress(toAddress, "toAddress");
  // Material ids are ObjectIds in production, strings in fixtures; both work as long as the caller is consistent.
  if (materialId === undefined || materialId === null || materialId === "") {
    throw new AppError("VALIDATION_FIELD", { message: "materialId is required.", details: { field: "materialId" } });
  }
  if (sameAddress(from, to)) {
    throw new AppError("VALIDATION_FAILED", { message: "You already own this material.", details: { reason: "self_transfer" } });
  }
  const ttl = ttlMs ?? DEFAULT_TRANSFER_TTL_MS;
  if (!Number.isFinite(ttl) || ttl < MIN_TRANSFER_TTL_MS || ttl > MAX_TRANSFER_TTL_MS) {
    throw new AppError("VALIDATION_FIELD", {
      message: "Transfer expiry is out of range.",
      details: { field: "ttlMs", min: MIN_TRANSFER_TTL_MS, max: MAX_TRANSFER_TTL_MS },
    });
  }

  const material = await db.collection("materials").findOne({ _id: materialId });
  if (!material) throw new AppError("NOT_FOUND_MATERIAL");
  if (!sameAddress(ownerOf(material), from)) {
    // Same answer for "not yours" and "not found" would hide the material from its
    // legitimate collaborators; the caller is authenticated, so a 403 is safe here.
    throw new AppError("AUTH_FORBIDDEN", { message: "Only the material owner can transfer it.", details: { reason: "not_owner" } });
  }
  const restricted = restrictedReason(material);
  if (restricted) {
    throw new AppError("CONFLICT_STATE", { message: "This material cannot be transferred right now.", details: { reason: restricted } });
  }

  const existing = await transfers(db).findOne({
    materialId,
    state: { $in: [TransferState.PENDING, TransferState.ACCEPTING] },
  });
  if (existing) {
    const live = await expireIfOverdue(db, existing, now);
    if (live.state === TransferState.PENDING && sameAddress(live.fromAddress, from) && sameAddress(live.toAddress, to)) {
      return { transfer: live, replayed: true };
    }
    if (live.state === TransferState.PENDING || live.state === TransferState.ACCEPTING) {
      throw new AppError("CONFLICT_IN_PROGRESS", {
        message: "This material already has a transfer in progress.",
        details: { reason: "transfer_in_progress", transferId: live._id },
      });
    }
  }

  const transfer = {
    _id: crypto.randomUUID(),
    materialId,
    fromAddress: ownerOf(material),
    toAddress: to,
    state: TransferState.PENDING,
    reason: typeof reason === "string" ? reason.trim().slice(0, MAX_REASON_LENGTH) : null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttl),
    history: [historyEntry("initiated", from, now)],
  };
  try {
    await transfers(db).insertOne(transfer);
  } catch (error) {
    // The unique "one live transfer per material" index caught a concurrent proposal.
    if (isDuplicateKey(error)) {
      throw new AppError("CONFLICT_IN_PROGRESS", {
        message: "This material already has a transfer in progress.",
        details: { reason: "transfer_in_progress" },
      });
    }
    throw error;
  }
  return { transfer, replayed: false };
}

/**
 * Recipient accepts. Safe to retry: an already-accepted transfer replays, an
 * interrupted accept is rolled back to pending (or forward if the owner swap landed).
 *
 * @returns {Promise<{transfer: object, material: object|null, replayed: boolean}>}
 */
export async function acceptTransfer(db, { transferId, actorAddress, now = new Date() }) {
  const actor = requireAddress(actorAddress, "actorAddress");
  let transfer = await loadTransfer(db, transferId);
  assertParty(transfer, actor, { allowed: "to" });
  await assertTransferNotDisputed(db, transferId);

  if (transfer.state === TransferState.ACCEPTED) return { transfer, material: null, replayed: true };

  transfer = await expireIfOverdue(db, transfer, now);
  if (transfer.state === TransferState.EXPIRED) {
    throw conflict("transfer_expired", transfer, "This transfer offer has expired. Ask the owner to send a new one.");
  }
  if (transfer.state === TransferState.ACCEPTING && transfer.leaseExpiresAt <= now) {
    const settled = await settleStuckTransfer(db, transfer, now);
    if (settled.state === TransferState.ACCEPTED) return { transfer: settled, material: null, replayed: true };
    transfer = settled;
  }
  if (transfer.state !== TransferState.PENDING) {
    throw conflict("transfer_not_pending", transfer, `This transfer is ${transfer.state} and cannot be accepted.`);
  }

  // Claim the transfer so a second accept (double click, two devices) cannot also swap the owner.
  const claimed = await transition(
    db,
    transferId,
    [TransferState.PENDING],
    { state: TransferState.ACCEPTING, leaseExpiresAt: new Date(now.getTime() + ACCEPT_LEASE_MS) },
    historyEntry("accepting", actor, now),
    { expiresAt: { $gt: now } }
  );
  if (!claimed) {
    throw new AppError("CONFLICT_IN_PROGRESS", {
      message: "This transfer is being accepted already.",
      details: { reason: "accept_in_progress", transferId },
    });
  }

  let material;
  try {
    material = unwrap(
      await db.collection("materials").findOneAndUpdate(
        { _id: claimed.materialId, userAddress: claimed.fromAddress, isDeleted: { $ne: true } },
        {
          $set: {
            userAddress: claimed.toAddress,
            previousOwnerAddress: claimed.fromAddress,
            ownershipTransferredAt: now,
            ownershipTransferId: claimed._id,
          },
          $inc: { version: 1 },
        },
        { returnDocument: "after" }
      )
    );
  } catch (error) {
    // Unknown whether the write landed. Settle from the material rather than guessing.
    await settleStuckTransfer(db, claimed, now).catch(() => {});
    throw error;
  }

  if (!material) {
    // The owner changed (or the material was deleted) after the offer was made.
    const failed = await transition(
      db,
      transferId,
      [TransferState.ACCEPTING],
      { state: TransferState.FAILED, failedAt: now, failureReason: "owner_changed" },
      historyEntry("failed", "system", now, { reason: "owner_changed" })
    );
    throw conflict("owner_changed", failed || claimed, "The material changed owners or was removed before the transfer completed.");
  }

  const accepted = await transition(
    db,
    transferId,
    [TransferState.ACCEPTING],
    { state: TransferState.ACCEPTED, acceptedAt: now },
    historyEntry("accepted", actor, now)
  );
  return { transfer: accepted || { ...claimed, state: TransferState.ACCEPTED }, material, replayed: false };
}

/** Recipient turns the offer down. Idempotent. */
export async function declineTransfer(db, { transferId, actorAddress, now = new Date() }) {
  const actor = requireAddress(actorAddress, "actorAddress");
  const transfer = await loadTransfer(db, transferId);
  assertParty(transfer, actor, { allowed: "to" });
  return closePending(db, transfer, actor, TransferState.DECLINED, "declined", "declinedAt", now);
}

/** Owner withdraws the offer (admins may too, for incident response). Idempotent. */
export async function cancelTransfer(db, { transferId, actorAddress, isAdmin = false, now = new Date() }) {
  const actor = requireAddress(actorAddress, "actorAddress");
  const transfer = await loadTransfer(db, transferId);
  assertParty(transfer, actor, { allowed: "from", admin: isAdmin });
  return closePending(db, transfer, actor, TransferState.CANCELLED, "cancelled", "cancelledAt", now);
}

async function closePending(db, transfer, actor, targetState, action, timeField, now) {
  await assertTransferNotDisputed(db, transfer._id);
  if (transfer.state === targetState) return { transfer, replayed: true };
  const current = await expireIfOverdue(db, transfer, now);
  if (current.state !== TransferState.PENDING) {
    throw conflict(`transfer_${current.state}`, current, `This transfer is ${current.state} and cannot be ${targetState}.`);
  }
  const updated = await transition(
    db,
    current._id,
    [TransferState.PENDING],
    { state: targetState, [timeField]: now },
    historyEntry(action, actor, now)
  );
  if (!updated) {
    // Lost a race with accept/expire; report what the transfer is now.
    const fresh = await transfers(db).findOne({ _id: current._id });
    throw conflict(`transfer_${fresh.state}`, fresh, `This transfer is ${fresh.state} and cannot be ${targetState}.`);
  }
  return { transfer: updated, replayed: false };
}

/**
 * Settle an `accepting` transfer whose worker died. The material is the source
 * of truth: if the new owner is already on it the transfer completes, otherwise
 * the claim is rolled back so the recipient can accept again.
 */
async function settleStuckTransfer(db, transfer, now) {
  const material = await db.collection("materials").findOne({ _id: transfer.materialId });
  if (material && sameAddress(ownerOf(material), transfer.toAddress) && material.ownershipTransferId === transfer._id) {
    const accepted = await transition(
      db,
      transfer._id,
      [TransferState.ACCEPTING],
      { state: TransferState.ACCEPTED, acceptedAt: material.ownershipTransferredAt || now },
      historyEntry("accepted", "recovery", now, { reason: "owner_swap_confirmed" })
    );
    return accepted || (await transfers(db).findOne({ _id: transfer._id }));
  }
  const expired = transfer.expiresAt <= now;
  const rolledBack = await transition(
    db,
    transfer._id,
    [TransferState.ACCEPTING],
    expired
      ? { state: TransferState.EXPIRED, expiredAt: now }
      : { state: TransferState.PENDING, leaseExpiresAt: null },
    historyEntry(expired ? "expired" : "rolled_back", "recovery", now, { reason: "accept_interrupted" })
  );
  return rolledBack || (await transfers(db).findOne({ _id: transfer._id }));
}

/**
 * Sweep for a cron or operator: expire overdue offers and settle abandoned accepts.
 * Re-running is harmless.
 */
export async function recoverStuckTransfers(db, { now = new Date(), limit = 100 } = {}) {
  const summary = { expired: 0, completed: 0, rolledBack: 0 };

  const overdue = await transfers(db)
    .find({ state: TransferState.PENDING, expiresAt: { $lte: now } })
    .limit(limit)
    .toArray();
  for (const transfer of overdue) {
    const result = await expireIfOverdue(db, transfer, now);
    if (result.state === TransferState.EXPIRED) summary.expired += 1;
  }

  const stuck = await transfers(db)
    .find({ state: TransferState.ACCEPTING, leaseExpiresAt: { $lte: now } })
    .limit(limit)
    .toArray();
  for (const transfer of stuck) {
    const result = await settleStuckTransfer(db, transfer, now);
    if (result.state === TransferState.ACCEPTED) summary.completed += 1;
    else if (result.state === TransferState.PENDING) summary.rolledBack += 1;
    else if (result.state === TransferState.EXPIRED) summary.expired += 1;
  }
  return summary;
}

/** Transfers a user sent or received, newest first. Pending offers past expiry are reported as expired. */
export async function listTransfersForUser(db, { address, state, limit = 50, now = new Date() }) {
  const user = requireAddress(address, "address");
  const rows = await transfers(db)
    .find({ $or: [{ fromAddress: user }, { toAddress: user }], ...(state ? { state } : {}) })
    .sort({ createdAt: -1, _id: 1 })
    .limit(Math.min(Math.max(limit, 1), 200))
    .toArray();
  return rows.map((row) =>
    row.state === TransferState.PENDING && row.expiresAt <= now ? { ...row, state: TransferState.EXPIRED } : row
  );
}
