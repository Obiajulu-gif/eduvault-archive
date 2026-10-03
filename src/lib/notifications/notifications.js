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

/**
 * Delivery lifecycle for a notification (#834). A notification is created
 * `pending`; a delivery attempt moves it to `sent` on success or `failed` on
 * the first error, and `exhausted` once retries reach `maxAttempts`.
 *
 * `sent` and `exhausted` are terminal: a retry never re-sends a `sent`
 * notification (so a retried source event can't double-notify) and never
 * re-runs an `exhausted` one.
 */
export const DELIVERY_STATUSES = Object.freeze({
  pending: "pending",
  sent: "sent",
  failed: "failed",
  exhausted: "exhausted",
});

const MAX_DELIVERY_ERROR_LENGTH = 200;

// Deep links must stay on this app: a stored "//evil.com" or absolute URL
// would turn a trusted notification into an open redirect.
function isInternalLink(link) {
  return typeof link === "string" && /^\/(?![/\\])/.test(link) && !/[\s\\]/.test(link);
}

/**
 * Reduce a delivery error to a short, sensitive-safe diagnostic. Stack traces
 * and arbitrary error payloads can carry PII or internal detail, so only the
 * message is kept — whitespace-collapsed and length-capped.
 */
function safeDeliveryError(error) {
  const raw = typeof error === "string" ? error : error?.message;
  const message = (raw ? String(raw) : "delivery_failed").replace(/\s+/g, " ").trim();
  return message.slice(0, MAX_DELIVERY_ERROR_LENGTH) || "delivery_failed";
}

/**
 * Create a notification exactly once per (recipient, dedupeKey). Retried
 * events reuse the same dedupeKey, so the upsert only inserts the first time.
 * Returns { created } — false when it already existed (and, crucially, when it
 * did, its delivery state is left untouched, so a retried event never re-sends
 * or resets an already-delivered notification).
 */
export async function notify(db, { recipient, type, dedupeKey, title, message, link = null }) {
  if (!recipient || !dedupeKey) throw new Error("notify requires recipient and dedupeKey");
  if (!NOTIFICATION_TYPES[type]) throw new Error(`Unknown notification type: ${type}`);
  if (link !== null && !isInternalLink(link)) throw new Error("Notification link must be an internal path");

  const now = new Date();
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
    // Delivery tracking (#834): a fresh notification starts pending; state is
    // only ever advanced by recordDeliveryAttempt/retryFailedDelivery.
    deliveryStatus: DELIVERY_STATUSES.pending,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    sentAt: null,
    createdAt: now,
    updatedAt: now,
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

/**
 * Record one delivery attempt against a notification. Increments `attempts`
 * and moves `deliveryStatus` to the given value.
 *
 * When `recipient` is provided the update is scoped to that recipient, so one
 * user can never flip another user's delivery state. A `failed`/`exhausted`
 * outcome is also refused against a notification already in the terminal
 * `sent` state (`deliveryStatus: { $ne: "sent" }`), so a late or racing
 * failure can never un-send a delivered notification.
 *
 * @returns {Promise<{ updated: boolean, deliveryStatus: string|null, attempts: number|null }>}
 */
export async function recordDeliveryAttempt(db, id, { recipient, status, error = null } = {}) {
  if (!ObjectId.isValid(id)) return { updated: false, deliveryStatus: null, attempts: null };
  if (!DELIVERY_STATUSES[status]) throw new Error(`Unknown delivery status: ${status}`);

  const now = new Date();
  const filter = { _id: new ObjectId(id), ...(recipient ? { recipient: String(recipient) } : {}) };
  if (status !== DELIVERY_STATUSES.sent) filter.deliveryStatus = { $ne: DELIVERY_STATUSES.sent };

  const update = {
    $set: {
      deliveryStatus: status,
      lastAttemptAt: now,
      updatedAt: now,
      lastError: status === DELIVERY_STATUSES.sent ? null : safeDeliveryError(error),
    },
    $inc: { attempts: 1 },
  };
  if (status === DELIVERY_STATUSES.sent) update.$set.sentAt = now;

  const updated = await db
    .collection(COLLECTIONS.notifications)
    .findOneAndUpdate(filter, update, { returnDocument: "after" });

  if (!updated) return { updated: false, deliveryStatus: null, attempts: null };
  return { updated: true, deliveryStatus: updated.deliveryStatus, attempts: updated.attempts ?? 0 };
}

/**
 * Safely (re)deliver a notification through `deliverFn`.
 *
 *   • `deliverFn(publicPayload)` is called at most once per invocation, with a
 *     recipient-scoped, `toPublic`-shaped payload (no recipient/dedupeKey), so
 *     a delivery callback can never leak another user's data.
 *   • A notification already `sent` is never delivered again — this is the
 *     duplicate-event / double-send guard.
 *   • An `exhausted` notification is not retried automatically.
 *   • `recipient` scopes the lookup and the update, so another user's
 *     notification can never be read or flipped.
 *
 * Returns a diagnostic object with the resulting `deliveryStatus`, `attempts`
 * (so far), `maxAttempts`, and the sanitized `error` on failure.
 *
 * @param {import('mongodb').Db} db
 * @param {string} id
 * @param {(payload: object) => Promise<void>} deliverFn
 * @param {{ recipient?: string, maxAttempts?: number }} [options]
 * @returns {Promise<{ outcome: string, deliveryStatus?: string, attempts?: number, maxAttempts?: number, error?: string, doubleSendPrevented?: boolean }>}
 */
export async function retryFailedDelivery(db, id, deliverFn, { recipient, maxAttempts = 3 } = {}) {
  if (typeof deliverFn !== "function") throw new Error("retryFailedDelivery requires a deliverFn");
  if (!ObjectId.isValid(id)) return { outcome: "not_found" };

  const filter = { _id: new ObjectId(id), ...(recipient ? { recipient: String(recipient) } : {}) };
  const doc = await db.collection(COLLECTIONS.notifications).findOne(filter);
  if (!doc) return { outcome: "not_found" };

  if (doc.deliveryStatus === DELIVERY_STATUSES.sent) {
    return {
      outcome: "already_sent",
      deliveryStatus: DELIVERY_STATUSES.sent,
      attempts: doc.attempts ?? 0,
      doubleSendPrevented: true,
    };
  }
  if (doc.deliveryStatus === DELIVERY_STATUSES.exhausted) {
    return {
      outcome: "exhausted",
      deliveryStatus: DELIVERY_STATUSES.exhausted,
      attempts: doc.attempts ?? 0,
      maxAttempts,
    };
  }

  const previousAttempts = doc.attempts ?? 0;

  try {
    await deliverFn(toPublic(doc));
    const recorded = await recordDeliveryAttempt(db, id, { recipient, status: DELIVERY_STATUSES.sent });
    return {
      outcome: "sent",
      deliveryStatus: DELIVERY_STATUSES.sent,
      attempts: recorded.attempts ?? previousAttempts + 1,
    };
  } catch (error) {
    const attempts = previousAttempts + 1;
    const status = attempts >= maxAttempts ? DELIVERY_STATUSES.exhausted : DELIVERY_STATUSES.failed;
    await recordDeliveryAttempt(db, id, { recipient, status, error });
    return {
      outcome: status,
      deliveryStatus: status,
      attempts,
      maxAttempts,
      error: safeDeliveryError(error),
    };
  }
}

/**
 * Operator-facing diagnostics for failed deliveries, scoped to one recipient
 * so a caller can only ever inspect their own inbox's delivery failures.
 * `lastError` is already sanitized by `recordDeliveryAttempt`.
 */
export async function getDeliveryDiagnostics(db, recipient, { limit = 50 } = {}) {
  const docs = await db
    .collection(COLLECTIONS.notifications)
    .find({
      recipient: String(recipient),
      deliveryStatus: { $in: [DELIVERY_STATUSES.failed, DELIVERY_STATUSES.exhausted] },
    })
    .sort({ lastAttemptAt: -1 })
    .limit(limit)
    .toArray();

  return docs.map((doc) => ({
    id: String(doc._id),
    type: doc.type,
    deliveryStatus: doc.deliveryStatus,
    attempts: doc.attempts ?? 0,
    lastAttemptAt: doc.lastAttemptAt ?? null,
    lastError: doc.lastError ?? null,
  }));
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
