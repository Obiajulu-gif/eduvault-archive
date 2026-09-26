import { ObjectId } from "mongodb";
import { COLLECTIONS } from "../backend/schemaContracts.js";

// #794: server-side notifications for events a user has to act on or know
// about. Recipient is always the session user id (`sub`), and every read or
// write below is filtered by it, so one user can never see or flip another
// user's notifications.
export const NOTIFICATION_TYPES = {
  import_completed: { severity: "success" },
  import_partial_failure: { severity: "error" },
};

// Deep links must stay on this app: a stored "//evil.com" or absolute URL
// would turn a trusted notification into an open redirect.
function isInternalLink(link) {
  return typeof link === "string" && /^\/(?![/\\])/.test(link) && !/[\s\\]/.test(link);
}

/**
 * Create a notification exactly once per (recipient, dedupeKey). Retried
 * events reuse the same dedupeKey, so the upsert only inserts the first time.
 * Returns { created } — false when it already existed.
 */
export async function notify(db, { recipient, type, dedupeKey, title, message, link = null }) {
  if (!recipient || !dedupeKey) throw new Error("notify requires recipient and dedupeKey");
  if (!NOTIFICATION_TYPES[type]) throw new Error(`Unknown notification type: ${type}`);
  if (link !== null && !isInternalLink(link)) throw new Error("Notification link must be an internal path");

  const doc = {
    recipient: String(recipient),
    type,
    severity: NOTIFICATION_TYPES[type].severity,
    dedupeKey,
    title,
    message,
    link,
    read: false,
    readAt: null,
    createdAt: new Date(),
  };

  try {
    const result = await db.collection(COLLECTIONS.notifications).updateOne(
      { recipient: doc.recipient, dedupeKey },
      { $setOnInsert: doc },
      { upsert: true }
    );
    return { created: result.upsertedCount === 1 };
  } catch (err) {
    // Two concurrent upserts can both miss and race on the unique index.
    if (err?.code === 11000) return { created: false };
    throw err;
  }
}

function toPublic(doc) {
  return {
    id: String(doc._id),
    type: doc.type,
    severity: doc.severity,
    title: doc.title,
    message: doc.message,
    link: doc.link,
    read: doc.read,
    createdAt: doc.createdAt,
  };
}

export async function listNotifications(db, recipient, { unreadOnly = false, limit = 20 } = {}) {
  const col = db.collection(COLLECTIONS.notifications);
  const filter = { recipient: String(recipient), ...(unreadOnly ? { read: false } : {}) };
  const [docs, unreadCount] = await Promise.all([
    col.find(filter).sort({ createdAt: -1 }).limit(limit).toArray(),
    col.countDocuments({ recipient: String(recipient), read: false }),
  ]);
  return { notifications: docs.map(toPublic), unreadCount };
}

/** Mark the given ids (or all, with `all: true`) read for this recipient only. */
export async function markNotificationsRead(db, recipient, { ids = [], all = false } = {}) {
  const filter = { recipient: String(recipient), read: false };
  if (!all) {
    const objectIds = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
    if (objectIds.length === 0) return { updated: 0 };
    filter._id = { $in: objectIds };
  }
  const result = await db.collection(COLLECTIONS.notifications).updateMany(
    filter,
    { $set: { read: true, readAt: new Date() } }
  );
  return { updated: result.modifiedCount };
}
