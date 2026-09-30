import { ObjectId } from "mongodb";
import { COLLECTIONS } from "../backend/schemaContracts.js";
import { isFeatureFlagEnabled } from "../featureFlags.js";

// #794: server-side notifications for events a user has to act on or know
// about. Recipient is always the session user id (`sub`), and every read or
// write below is filtered by it, so one user can never see or flip another
// user's notifications.
//
// #776 extends the registry with the critical lifecycle / recovery events a
// user must act on or know about. Each type carries a severity (drives inbox
// styling) and a default deep link into the relevant workflow. Deep links are
// always internal paths — see isInternalLink below.
export const NOTIFICATION_TYPES = {
  import_completed: { severity: "success", defaultLink: "/dashboard/my-materials" },
  import_partial_failure: { severity: "error", defaultLink: "/dashboard/my-materials" },

  // ── critical lifecycle / recovery events (#776) ──────────────────────────
  purchase_completed: { severity: "success", defaultLink: "/dashboard/purchases" },
  payment_failed: { severity: "error", defaultLink: "/dashboard/purchases" },
  refund_requested: { severity: "info", defaultLink: "/dashboard/purchases" },
  refund_settled: { severity: "success", defaultLink: "/dashboard/purchases" },
  refund_failed: { severity: "error", defaultLink: "/dashboard/purchases" },
  entitlement_revoked: { severity: "warning", defaultLink: "/dashboard/library" },
  payout_processed: { severity: "success", defaultLink: "/dashboard/analytics" },
  account_suspended: { severity: "error", defaultLink: "/support" },
  account_reactivated: { severity: "info", defaultLink: "/dashboard" },
  wallet_recovery_completed: { severity: "success", defaultLink: "/dashboard/settings" },
};

/**
 * The subset of notification types gated behind the
 * CRITICAL_LIFECYCLE_NOTIFICATIONS feature flag (#777/#797). Import
 * notifications (#794) predate the flag system and always fire.
 */
export const FEATURE_FLAG_GATED_TYPES = new Set([
  "purchase_completed",
  "payment_failed",
  "refund_requested",
  "refund_settled",
  "refund_failed",
  "entitlement_revoked",
  "payout_processed",
  "account_suspended",
  "account_reactivated",
  "wallet_recovery_completed",
]);

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

/**
 * Resolve a wallet address to the notification recipient (the user's MongoDB
 * `_id`, which is what `recipient` stores). Returns null when no user record
 * exists for the address — there is no inbox to deliver into, so the caller
 * skips the notification rather than guessing a recipient.
 *
 * @param {import('mongodb').Db} db
 * @param {string} walletAddress
 * @returns {Promise<string|null>}
 */
export async function resolveRecipientByWallet(db, walletAddress) {
  if (!walletAddress) return null;
  try {
    const user = await db
      .collection(COLLECTIONS.users)
      .findOne(
        { walletAddressLower: String(walletAddress).toLowerCase() },
        { projection: { _id: 1 } },
      );
    return user ? String(user._id) : null;
  } catch {
    return null;
  }
}

/**
 * Notify the user that owns `walletAddress`, gated behind the
 * CRITICAL_LIFECYCLE_NOTIFICATIONS feature flag (#797).
 *
 * Backend workflows (refund settlement, payout, suspension) know a wallet
 * address, not a session user id, so this helper resolves the recipient from
 * the address and applies the feature-flag gate in one place. Returns
 * `{ created: false, skipped }` when the flag is off or the recipient cannot
 * be resolved, so callers can fire-and-forget without branching.
 *
 * @param {import('mongodb').Db} db
 * @param {object} event - Same shape as `notify`, minus `recipient`.
 * @returns {Promise<{ created: boolean, skipped?: string }>}
 */
export async function notifyWalletRecipient(db, event) {
  if (!isFeatureFlagEnabled("CRITICAL_LIFECYCLE_NOTIFICATIONS")) {
    return { created: false, skipped: "feature_flag_disabled" };
  }
  const recipient = await resolveRecipientByWallet(db, event.walletAddress);
  if (!recipient) {
    return { created: false, skipped: "recipient_not_found" };
  }
  const { walletAddress, ...rest } = event;
  const result = await notify(db, { ...rest, recipient });
  return { ...result, skipped: result.created ? undefined : "deduplicated" };
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
