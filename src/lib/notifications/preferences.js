import { COLLECTIONS } from "../backend/schemaContracts.js";

// #976: notification preferences. Only the types listed here can be switched
// off by a user. Every other type is mandatory: lifecycle, money and security
// alerts that are always delivered and always leave an auditable record.
// Unknown types are treated as mandatory, so a new type fails safe.
export const OPTIONAL_NOTIFICATION_TYPES = Object.freeze(new Set([
  "import_completed",
  "import_partial_failure",
]));

export class NotificationPreferenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotificationPreferenceError";
  }
}

export function isMandatoryNotification(type) {
  return !OPTIONAL_NOTIFICATION_TYPES.has(type);
}

/**
 * Pure routing decision for one notification. `enabled` is the user's stored
 * preference for an optional type (undefined when they never set one).
 *
 *   mandatory          → always deliver
 *   optional, opted out → suppressed, but the record is still written
 *   optional otherwise → deliver
 */
export function resolveNotificationDelivery({ type, enabled }) {
  if (isMandatoryNotification(type)) return { deliver: true, reason: "mandatory" };
  if (enabled === false) return { deliver: false, reason: "opted_out" };
  return { deliver: true, reason: enabled === true ? "opted_in" : "default" };
}

/** Reads the stored preference for one recipient and type, then routes it. */
export async function getNotificationDelivery(db, recipient, type) {
  if (isMandatoryNotification(type)) return resolveNotificationDelivery({ type });
  const pref = await db.collection(COLLECTIONS.notificationPreferences).findOne(
    { recipient: String(recipient), type },
    { projection: { enabled: 1 } },
  );
  return resolveNotificationDelivery({ type, enabled: pref?.enabled });
}

/**
 * Sets an optional notification type on or off for one recipient. Mandatory
 * types are refused, so a stored preference can never silence a security or
 * lifecycle alert.
 */
export async function setNotificationPreference(db, recipient, type, enabled) {
  if (!OPTIONAL_NOTIFICATION_TYPES.has(type)) {
    throw new NotificationPreferenceError(`"${type}" is a mandatory notification and cannot be turned off`);
  }
  if (typeof enabled !== "boolean") {
    throw new NotificationPreferenceError("enabled must be true or false");
  }

  const now = new Date();
  const owner = String(recipient);
  await db.collection(COLLECTIONS.notificationPreferences).updateOne(
    { recipient: owner, type },
    {
      $set: { enabled, updatedAt: now },
      $setOnInsert: { recipient: owner, type, createdAt: now },
    },
    { upsert: true },
  );
  return { type, enabled, mandatory: false };
}

/** The recipient's optional-type preferences. Defaults to enabled. */
export async function listNotificationPreferences(db, recipient) {
  const docs = await db.collection(COLLECTIONS.notificationPreferences)
    .find({ recipient: String(recipient) })
    .toArray();
  const stored = new Map(docs.map((doc) => [doc.type, doc.enabled]));
  return [...OPTIONAL_NOTIFICATION_TYPES].map((type) => ({
    type,
    enabled: stored.get(type) !== false,
    mandatory: false,
  }));
}
