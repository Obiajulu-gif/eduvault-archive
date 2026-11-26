import crypto from "node:crypto";
import { COLLECTIONS } from "../backend/schemaContracts.js";

export function buildNotificationDeliveryReceipt({ notification, status, attempt, at = new Date(), error = null }) {
  const payload = {
    notificationId: String(notification._id),
    recipient: String(notification.recipient),
    dedupeKey: notification.dedupeKey,
    type: notification.type,
    status,
    attempt,
    at: at.toISOString(),
    error,
  };
  const receiptId = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { receiptId, ...payload, createdAt: at };
}

export async function listDeliveryReceipts(db, recipient, { limit = 50 } = {}) {
  const collectionName = COLLECTIONS.notificationDeliveryReceipts || "notification_delivery_receipts";
  const docs = await db
    .collection(collectionName)
    .find({ recipient: String(recipient) })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
  return docs.map((doc) => ({
    receiptId: doc.receiptId,
    notificationId: doc.notificationId,
    dedupeKey: doc.dedupeKey,
    type: doc.type,
    status: doc.status,
    attempt: doc.attempt,
    at: doc.at,
    error: doc.error ?? null,
  }));
}
