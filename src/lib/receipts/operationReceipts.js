import crypto from "node:crypto";
import { COLLECTIONS } from "../backend/schemaContracts.js";

const RECEIPT_VERSION = "v1";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = canonicalize(value[key]);
      return acc;
    }, {});
  }
  return value;
}

export function buildOperationReceipt({ actor, operation, status, payload = {}, externalRefs = {}, dedupeKey = null, now = new Date() }) {
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const body = {
    version: RECEIPT_VERSION,
    actor: String(actor || ""),
    operation: String(operation || ""),
    status: String(status || ""),
    timestamp,
    externalRefs: canonicalize(externalRefs || {}),
    payload: canonicalize(payload || {}),
    ...(dedupeKey ? { dedupeKey: String(dedupeKey) } : {}),
  };
  const canonical = JSON.stringify(body);
  const payloadHash = crypto.createHash("sha256").update(canonical).digest("hex");
  const signature = crypto.createHmac("sha256", process.env.RECEIPT_SIGNING_SECRET || "dev-receipt-secret")
    .update(payloadHash)
    .digest("hex");
  const receiptId = `rcpt_${payloadHash.slice(0, 32)}`;
  return {
    _id: receiptId,
    id: receiptId,
    receiptId,
    ...body,
    payloadHash,
    signature,
    createdAt: new Date(timestamp),
  };
}

export function verifyOperationReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") return false;
  const expected = buildOperationReceipt({
    actor: receipt.actor,
    operation: receipt.operation,
    status: receipt.status,
    payload: receipt.payload,
    externalRefs: receipt.externalRefs,
    dedupeKey: receipt.dedupeKey,
    now: receipt.timestamp,
  });
  return expected.payloadHash === receipt.payloadHash && expected.signature === receipt.signature;
}

export async function createOrGetOperationReceipt(db, input) {
  const receipt = buildOperationReceipt(input);
  const col = db.collection(COLLECTIONS.operationReceipts || COLLECTIONS.receipts || "operation_receipts");
  const filter = input.dedupeKey ? { dedupeKey: String(input.dedupeKey) } : { receiptId: receipt.receiptId };
  const existing = await col.findOne(filter);
  if (existing) return { receipt: existing, created: false };
  try {
    await col.insertOne(receipt);
    return { receipt, created: true };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const stored = await col.findOne(filter);
    return { receipt: stored || receipt, created: false };
  }
}

export async function getOperationReceipt(db, id) {
  const col = db.collection(COLLECTIONS.operationReceipts || COLLECTIONS.receipts || "operation_receipts");
  return col.findOne({ $or: [{ receiptId: String(id) }, { _id: String(id) }, { id: String(id) }] });
}
