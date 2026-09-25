/**
 * Append-only writer for the administrative audit log.
 *
 * This module is deliberately the *only* way the application touches
 * `admin_audit_log`, and it exposes no update or delete path. Combined with the
 * `ADMIN_AUDIT_GRANT` privilege document (find + insert, no update, no remove)
 * that is what makes the log resistant to the insider it exists to catch.
 */

import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_COLLECTION,
} from "./schemas/auditLog.js";

/**
 * Resolve the database lazily.
 *
 * Imported dynamically rather than at module scope so this module can be unit
 * tested with an injected `db` without pulling in the MongoDB driver — the
 * `node --test` backend suite runs without a database.
 */
async function resolveDb(injected) {
  if (injected) return injected;
  const { getDb } = await import("../mongodb.js");
  return getDb();
}

const VALID_ACTIONS = new Set(Object.values(ADMIN_AUDIT_ACTIONS));

/** Strip control characters and trim to a length the schema will accept. */
function toAuditString(value, maxLength = 300) {
  if (value === undefined || value === null) return null;
  const text = String(value)
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  return text.length === 0 ? null : text.slice(0, maxLength);
}

/**
 * Build the audit row without writing it.
 *
 * Separated from the insert so the shape can be unit tested without a database,
 * and so callers get a synchronous validation error for a bad action name
 * rather than a driver-level schema rejection at write time.
 */
export function buildAdminAuditEntry({
  adminId,
  targetUser,
  action,
  reason,
  metadata,
  now = new Date(),
}) {
  const admin_id = toAuditString(adminId);
  const target_user = toAuditString(targetUser);

  if (!admin_id) throw new Error("adminId is required for an admin audit entry");
  if (!target_user) throw new Error("targetUser is required for an admin audit entry");
  if (!VALID_ACTIONS.has(action)) {
    throw new Error(`Unknown admin audit action: ${String(action)}`);
  }

  const entry = {
    admin_id,
    target_user,
    action_taken: action,
    reason: toAuditString(reason),
    // Server clock, never a caller-supplied timestamp — an admin must not be
    // able to backdate their own trail.
    timestamp: now instanceof Date ? now : new Date(now),
  };

  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    entry.metadata = metadata;
  }

  return entry;
}

/**
 * Append one row to the audit log.
 *
 * Awaited by callers before the mutating endpoint returns, so a change can
 * never be committed without its audit row. Throws on failure for the same
 * reason — silently dropping the record would leave the change unattributed.
 */
export async function recordAdminAction(input) {
  const entry = buildAdminAuditEntry(input);
  const db = await resolveDb(input.db);
  await db.collection(ADMIN_AUDIT_COLLECTION).insertOne(entry);
  return entry;
}

/**
 * Read the audit trail. Supports the two queries the admin UI needs — by actor
 * and by target — both backed by indexes declared in the schema module.
 */
export async function listAdminAuditEntries({
  adminId,
  targetUser,
  action,
  limit = 50,
  db: injectedDb,
} = {}) {
  const db = await resolveDb(injectedDb);
  const query = {};
  if (adminId) query.admin_id = toAuditString(adminId);
  if (targetUser) query.target_user = toAuditString(targetUser);
  if (action) query.action_taken = action;

  return db
    .collection(ADMIN_AUDIT_COLLECTION)
    .find(query)
    .sort({ timestamp: -1 })
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 200))
    .toArray();
}
