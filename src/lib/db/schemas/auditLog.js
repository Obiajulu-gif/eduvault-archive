/**
 * Administrative Audit Log Schema
 *
 * Records every privileged action an admin takes against another account —
 * suspensions, reactivations, role changes, refund overrides — so insider abuse
 * leaves a trail that the abuser cannot quietly remove.
 *
 * Two properties matter more than the field list:
 *
 *   1. **Append-only.** The collection is written through
 *      `src/lib/db/adminAudit.js`, which exposes no update or delete path. The
 *      Mongo role the application connects with should additionally be denied
 *      `update` and `remove` on this collection — see `ADMIN_AUDIT_GRANT` below
 *      for the exact privilege document. Application-level discipline alone is
 *      not a control against someone who already has admin access.
 *
 *   2. **Written in the same request as the change.** An audit row appended by
 *      a background job can be lost if the job never runs. `recordAdminAction`
 *      is awaited before the mutating endpoint returns.
 */

export const ADMIN_AUDIT_COLLECTION = "admin_audit_log";

/** Actions currently recorded. Extend as new privileged endpoints are added. */
export const ADMIN_AUDIT_ACTIONS = Object.freeze({
  USER_SUSPENDED: "user_suspended",
  USER_REACTIVATED: "user_reactivated",
  ROLE_CHANGED: "role_changed",
  MATERIAL_SOFT_DELETED: "material_soft_deleted",
  MATERIAL_RESTORED: "material_restored",
  REFUND_OVERRIDDEN: "refund_overridden",
});

export const AuditLogSchema = {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["admin_id", "target_user", "action_taken", "timestamp"],
      properties: {
        admin_id: {
          bsonType: "string",
          description: "Identifier of the admin who performed the action",
        },
        target_user: {
          bsonType: "string",
          description:
            "Identifier of the account or resource the action was taken against",
        },
        action_taken: {
          bsonType: "string",
          enum: Object.values(ADMIN_AUDIT_ACTIONS),
          description: "Which privileged action was performed",
        },
        reason: {
          bsonType: ["string", "null"],
          description: "Justification supplied by the admin, when one is required",
        },
        timestamp: {
          bsonType: "date",
          description: "When the action was performed, set server-side",
        },
        metadata: {
          bsonType: "object",
          description:
            "Action-specific context (previous role, material id, …). Never " +
            "used for the fields above so queries stay indexable.",
        },
      },
    },
  },
  // Reject anything that does not match rather than warning and storing it: a
  // malformed audit row is worse than a loud failure, because it reads as
  // coverage that is not there.
  validationLevel: "strict",
  validationAction: "error",
};

/**
 * Indexes for the audit collection.
 *
 * Merged into `REQUIRED_INDEXES` so the existing `ensureIndexes` bootstrap and
 * the index verification suite both pick them up automatically.
 */
export const ADMIN_AUDIT_INDEXES = [
  { keys: { timestamp: -1 }, options: { name: "admin_audit_timestamp_idx" } },
  { keys: { admin_id: 1, timestamp: -1 }, options: { name: "admin_audit_admin_idx" } },
  { keys: { target_user: 1, timestamp: -1 }, options: { name: "admin_audit_target_idx" } },
  { keys: { action_taken: 1, timestamp: -1 }, options: { name: "admin_audit_action_idx" } },
];

/**
 * MongoDB privilege document granting the application role append-only access.
 *
 * Apply with `db.grantPrivilegesToRole(...)` when provisioning the database
 * user. `find` and `insert` only — no `update`, no `remove`, so a compromised
 * or malicious admin holding standard application credentials cannot rewrite
 * history through the driver.
 */
export const ADMIN_AUDIT_GRANT = Object.freeze({
  resource: { db: "", collection: ADMIN_AUDIT_COLLECTION },
  actions: ["find", "insert"],
});
