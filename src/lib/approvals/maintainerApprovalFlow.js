import crypto from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { canonicalHash } from "../canonical.js";
import { appendAuditRecord } from "../backend/auditLedger.js";
import { COLLECTIONS } from "../backend/schemaContracts.js";

/**
 * Maintainer action approval flow with signed intent receipts (#953).
 *
 * `policySimulator.assertPolicyCommitAllowed` already gates high-impact
 * commits behind a `secondaryApprover` field, but that field is just a
 * string the caller supplies — nothing verifies the named maintainer ever
 * actually reviewed the action. This module replaces "a name in a request
 * body" with a cryptographic receipt:
 *
 *   1. `createApprovalIntent` — the proposing maintainer describes the
 *      action. Its fields are hashed into `intentHash`.
 *   2. `getApprovalSigningMessage` — a second maintainer signs this exact
 *      message with their wallet (the same Stellar Ed25519 keypair used for
 *      login, see auth/challenge.js), proving *that specific maintainer*
 *      reviewed *that exact* action.
 *   3. `createSignedReceipt` — verifies the signature and produces an
 *      immutable receipt bound to `intentHash`. A receipt cannot be created
 *      with an invalid signature or a self-approval.
 *   4. `assertApprovalReceiptValid` — the gate the action executor calls
 *      immediately before doing anything irreversible. It re-verifies the
 *      signature from scratch; a stored "verified" flag is never trusted.
 *   5. `persistApprovalReceipt` — writes the receipt to its own collection
 *      and to the tamper-evident audit ledger.
 *
 * Domain separation (`SIGNING_DOMAIN`) keeps an approval signature from ever
 * being replayable as a wallet-login challenge signature or vice versa.
 */

export class ApprovalFlowError extends Error {
  constructor(message, code = "APPROVAL_FLOW_ERROR", status = 400, details = null) {
    super(message);
    this.name = "ApprovalFlowError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Maintainers get 30 minutes to produce a signature before the intent expires. */
export const APPROVAL_INTENT_TTL_MS = 30 * 60 * 1000;

export const APPROVAL_DECISIONS = Object.freeze(["approved", "rejected"]);

const SIGNING_DOMAIN = "eduvault:maintainer-approval:v1";

function generateIntentId(actionType) {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(6).toString("hex");
  return `approval_${String(actionType).toLowerCase()}_${timestamp}_${random}`;
}

function normalizeAddress(address) {
  return String(address || "").trim();
}

/**
 * Build an approval intent describing a proposed maintainer action. This is
 * a *proposal only* — it authorizes nothing by itself. `payload` should be
 * the minimal data needed to review and later re-verify the action (e.g.
 * `{ materialIds: [...] }`), never raw secrets or full records.
 */
export function createApprovalIntent({
  actionType,
  actor,
  target,
  payload = {},
  reason,
  now = new Date(),
  ttlMs = APPROVAL_INTENT_TTL_MS,
}) {
  if (!actionType || typeof actionType !== "string") {
    throw new ApprovalFlowError("actionType is required", "INVALID_ACTION_TYPE");
  }
  if (!actor) {
    throw new ApprovalFlowError("actor is required", "INVALID_ACTOR");
  }
  if (!target || typeof target !== "object" || !target.type || !target.id) {
    throw new ApprovalFlowError("target.type and target.id are required", "INVALID_TARGET");
  }
  if (!reason || !String(reason).trim()) {
    throw new ApprovalFlowError("reason is required for a maintainer approval intent", "REASON_REQUIRED");
  }

  const intentId = generateIntentId(actionType);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

  const intent = {
    intentId,
    actionType: String(actionType),
    actor: normalizeAddress(actor),
    target: { type: String(target.type), id: String(target.id) },
    payload,
    reason: String(reason).slice(0, 500),
    createdAt,
    expiresAt,
  };

  // Binds the signature to every field above: changing the payload, target,
  // or reason after the fact produces a different hash, so a stale
  // signature can never be replayed onto a different action.
  intent.intentHash = canonicalHash(intent);
  return Object.freeze(intent);
}

/**
 * The exact message an approving maintainer's wallet must sign. Callers
 * sha256-digest this string and sign the digest with the maintainer's
 * Stellar keypair (mirrors the login-challenge convention).
 */
export function getApprovalSigningMessage(intent) {
  return `${SIGNING_DOMAIN}:${intent.intentHash}`;
}

function digestMessage(message) {
  return crypto.createHash("sha256").update(message, "utf8").digest();
}

/**
 * Verifies that `signatureHex` is a valid Ed25519 signature produced by the
 * Stellar keypair for `approverAddress` over this intent's signing message.
 */
export function verifyApprovalSignature({ intent, approverAddress, signatureHex }) {
  if (!intent?.intentHash || !approverAddress || !signatureHex) return false;
  try {
    const keypair = Keypair.fromPublicKey(normalizeAddress(approverAddress));
    const digest = digestMessage(getApprovalSigningMessage(intent));
    const signature = Buffer.from(signatureHex, "hex");
    return keypair.verify(digest, signature);
  } catch {
    return false;
  }
}

/**
 * Verify the signature and build the signed receipt. Throws rather than
 * returning a partially-valid receipt — a receipt object must never exist
 * unless it is genuinely signed, unexpired, and not a self-approval.
 */
export function createSignedReceipt({ intent, approverAddress, signatureHex, decision, now = new Date() }) {
  if (!intent?.intentHash) {
    throw new ApprovalFlowError("A valid approval intent is required", "MISSING_INTENT");
  }
  if (!APPROVAL_DECISIONS.includes(decision)) {
    throw new ApprovalFlowError(`Invalid approval decision: ${String(decision)}`, "INVALID_DECISION");
  }
  const approver = normalizeAddress(approverAddress);
  if (approver.toLowerCase() === intent.actor.toLowerCase()) {
    throw new ApprovalFlowError(
      "Self-approval is forbidden: the approver cannot be the maintainer who proposed the action.",
      "SELF_APPROVAL_FORBIDDEN",
      422
    );
  }
  if (new Date(intent.expiresAt).getTime() < now.getTime()) {
    throw new ApprovalFlowError("Approval intent has expired", "INTENT_EXPIRED", 410);
  }
  if (!verifyApprovalSignature({ intent, approverAddress: approver, signatureHex })) {
    throw new ApprovalFlowError("Invalid approval signature", "INVALID_SIGNATURE", 401);
  }

  return Object.freeze({
    receiptId: `receipt_${intent.intentId}`,
    intentId: intent.intentId,
    intentHash: intent.intentHash,
    approverAddress: approver,
    decision,
    signature: String(signatureHex),
    signedAt: now.toISOString(),
  });
}

/**
 * Gate run immediately before executing the maintainer action itself.
 * Re-derives validity from first principles — binding, expiry, decision,
 * self-approval, and the signature itself are all re-checked here rather
 * than trusting a previously-stored "verified" flag.
 */
export function assertApprovalReceiptValid({ intent, receipt, now = new Date() }) {
  if (!intent?.intentHash) {
    throw new ApprovalFlowError("A valid approval intent is required", "MISSING_INTENT");
  }
  if (!receipt || receipt.intentHash !== intent.intentHash) {
    throw new ApprovalFlowError(
      "Receipt does not match this intent's hash — it may belong to a different action.",
      "RECEIPT_INTENT_MISMATCH",
      409
    );
  }
  if (new Date(intent.expiresAt).getTime() < now.getTime()) {
    throw new ApprovalFlowError("Approval intent has expired", "INTENT_EXPIRED", 410);
  }
  if (receipt.decision !== "approved") {
    throw new ApprovalFlowError(
      `Action is not authorized: receipt decision is "${receipt.decision}".`,
      "NOT_APPROVED",
      403
    );
  }
  if (receipt.approverAddress.toLowerCase() === intent.actor.toLowerCase()) {
    throw new ApprovalFlowError(
      "Self-approval is forbidden: the approver cannot be the maintainer who proposed the action.",
      "SELF_APPROVAL_FORBIDDEN",
      422
    );
  }
  if (!verifyApprovalSignature({ intent, approverAddress: receipt.approverAddress, signatureHex: receipt.signature })) {
    throw new ApprovalFlowError("Invalid approval signature", "INVALID_SIGNATURE", 401);
  }
  return true;
}

/**
 * Persists a proposed intent so the signing step can load the server's own
 * copy of it rather than trusting a client-echoed object. Idempotent on
 * `intentId`.
 */
export async function persistApprovalIntent(db, intent) {
  const collection = db.collection(COLLECTIONS.maintainerApprovalIntents);
  await collection.updateOne(
    { intentId: intent.intentId },
    { $setOnInsert: { ...intent, createdAt: new Date() } },
    { upsert: true }
  );
  return intent;
}

/**
 * Loads a previously persisted intent by id. Returns null if it was never
 * created or has since expired — callers must not sign or act on a missing
 * intent.
 */
export async function loadApprovalIntent(db, intentId, { now = new Date() } = {}) {
  const collection = db.collection(COLLECTIONS.maintainerApprovalIntents);
  const stored = await collection.findOne({ intentId: String(intentId) });
  if (!stored) return null;
  if (new Date(stored.expiresAt).getTime() < now.getTime()) return null;
  const { _id, createdAt, ...intent } = stored;
  return intent;
}

/**
 * Persists a signed receipt: once in its own collection for direct lookup,
 * and once more as evidence in the tamper-evident audit ledger. Idempotent
 * on `receiptId` — a retry never double-appends.
 */
export async function persistApprovalReceipt(db, { intent, receipt }) {
  assertApprovalReceiptValid({ intent, receipt });

  const collection = db.collection(COLLECTIONS.maintainerApprovalReceipts);
  await collection.updateOne(
    { receiptId: receipt.receiptId },
    { $setOnInsert: { ...receipt, intent, createdAt: new Date() } },
    { upsert: true }
  );

  return appendAuditRecord({
    db,
    operationId: receipt.receiptId,
    actor: receipt.approverAddress,
    actorContext: { role: "approving_maintainer" },
    action: "maintainer_action_approval",
    target: intent.target,
    intent: { actionType: intent.actionType, intentHash: intent.intentHash, proposedBy: intent.actor },
    result: { decision: receipt.decision, intentId: intent.intentId },
    reason: intent.reason,
  });
}

/**
 * Loads a previously persisted receipt by intent id, for an action executor
 * that needs to confirm approval before proceeding.
 */
export async function loadApprovalReceipt(db, intentId) {
  const collection = db.collection(COLLECTIONS.maintainerApprovalReceipts);
  const stored = await collection.findOne({ intentId: String(intentId) });
  if (!stored) return null;
  const { _id, intent, createdAt, ...receipt } = stored;
  return receipt;
}
