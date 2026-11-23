import crypto from "node:crypto";
import { ObjectId } from "mongodb";
import { COLLECTIONS } from "../backend/schemaContracts.js";

/**
 * User-visible operation history (#882).
 *
 * A read model over the tamper-evident `audit_ledger`, which already records
 * every important operation (purchases, refunds, listings, account and
 * identity changes). Nothing new is written. The ledger is the single source
 * of truth, so the history can't drift from what actually happened.
 *
 * Visibility is allow-list only: a ledger action appears only when registered
 * in OPERATION_HISTORY_EVENTS, and only for the user it belongs to:
 *
 *   actor    the user performed it (`actor` is one of the user's identities)
 *   subject  it was performed on the user's account (`target` is the user)
 *   owner    it touched a resource the user owns (e.g. their refund)
 *
 * Redaction is allow-list as well. Each event exposes only its registered
 * `details` keys. Maintainer and system actors are reported as "eduvault",
 * never by id, and internal fields (actorProof, intentHash, before/after
 * snapshots, hashes, operation ids, reasons, correlation ids) are never read
 * into the response.
 *
 * Pagination is keyset on the ledger's unique, monotonic `sequence`, so pages
 * are stable while new operations are appended.
 */

export const OPERATION_CATEGORIES = Object.freeze(["purchase", "refund", "content", "account", "identity"]);

const event = (type, category, visibleTo, { resource = null, details = ["status"] } = {}) =>
  Object.freeze({ type, category, visibleTo, resource, details: Object.freeze(details) });

/** Ledger action → user-facing event. Unlisted actions are internal and never shown. */
export const OPERATION_HISTORY_EVENTS = Object.freeze({
  "purchase.reserved": event("purchase.started", "purchase", "actor", { resource: "material" }),
  "purchase.committed": event("purchase.completed", "purchase", "actor", { resource: "material", details: ["status", "purchaseId"] }),
  "purchase.released": event("purchase.cancelled", "purchase", "actor", { resource: "material" }),
  "purchase.payment_confirmed": event("purchase.payment_confirmed", "purchase", "actor", { resource: "purchase" }),
  "refund.requested": event("refund.requested", "refund", "owner", { resource: "refund" }),
  "refund.approved": event("refund.approved", "refund", "owner", { resource: "refund" }),
  "refund.rejected": event("refund.rejected", "refund", "owner", { resource: "refund" }),
  "refund.settled": event("refund.settled", "refund", "owner", { resource: "refund" }),
  "refund.entitlement_revoked": event("refund.access_revoked", "refund", "owner", { resource: "refund" }),
  "material.access_terms_updated": event("material.updated", "content", "actor", { resource: "material", details: [] }),
  "material.catalog_access_revoked": event("material.retired", "content", "actor", { resource: "material", details: [] }),
  "material.catalog_access_restored": event("material.restored", "content", "actor", { resource: "material", details: [] }),
  "user.student_verification_submitted": event("verification.submitted", "account", "actor"),
  "user.role_changed": event("account.role_changed", "account", "subject", { details: ["newRole"] }),
  "user.suspend": event("account.suspended", "account", "subject"),
  "user.reactivate": event("account.reactivated", "account", "subject"),
  "identity.linked": event("identity.linked", "identity", "subject", { details: ["status", "provider", "linkId"] }),
  "identity.unlinked": event("identity.unlinked", "identity", "subject", { details: ["status", "provider", "linkId"] }),
  "identity.link_failed": event("identity.link_failed", "identity", "subject", { details: ["status", "provider"] }),
});

const EVENT_TYPES = new Set(Object.values(OPERATION_HISTORY_EVENTS).map((e) => e.type));
const actionsWhere = (predicate) =>
  Object.entries(OPERATION_HISTORY_EVENTS)
    .filter(([, definition]) => predicate(definition))
    .map(([action]) => action);

/**
 * Resolvers for the `owner` rule: ids of resources of `type` owned by the
 * user. Only resource types listed here can carry owner-visible events.
 */
const OWNED_RESOURCE_RESOLVERS = Object.freeze({
  refund: async (db, identities) => {
    const rows = await db
      .collection(COLLECTIONS.refunds)
      .find({ buyerAddress: { $in: identities } }, { projection: { _id: 1 } })
      .toArray();
    return rows.map((row) => String(row._id));
  },
});

export const HISTORY_DEFAULT_LIMIT = 20;
export const HISTORY_MAX_LIMIT = 100;

export class OperationHistoryError extends Error {
  constructor(message, code = "INVALID_HISTORY_QUERY", status = 400) {
    super(message);
    this.name = "OperationHistoryError";
    this.code = code;
    this.status = status;
  }
}

/** Every identity the ledger may record for this user (id, wallet in stored casings). */
export function userIdentities(user) {
  const wallet = user?.walletAddress ? String(user.walletAddress) : null;
  const ids = [user?._id, user?.sub, wallet, wallet?.toLowerCase(), wallet?.toUpperCase()]
    .filter(Boolean)
    .map(String);
  if (ids.length === 0) throw new OperationHistoryError("Authenticated user required", "AUTH_REQUIRED", 401);
  return [...new Set(ids)];
}

function parseDate(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new OperationHistoryError(`Invalid ${field} date`);
  return date;
}

/** Validate and normalize query parameters. */
export function parseHistoryQuery({ category, type, from, to, limit, cursor } = {}) {
  if (category && !OPERATION_CATEGORIES.includes(category)) throw new OperationHistoryError("Unknown category");
  if (type && !EVENT_TYPES.has(type)) throw new OperationHistoryError("Unknown event type");

  const parsedLimit = limit === undefined || limit === null || limit === "" ? HISTORY_DEFAULT_LIMIT : Number(limit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1) throw new OperationHistoryError("limit must be a positive integer");

  const filters = {
    category: category || null,
    type: type || null,
    from: parseDate(from, "from"),
    to: parseDate(to, "to"),
  };
  if (filters.from && filters.to && filters.from > filters.to) throw new OperationHistoryError("from must not be after to");

  return { filters, limit: Math.min(parsedLimit, HISTORY_MAX_LIMIT), cursor: cursor || null };
}

function filterFingerprint(filters) {
  const canonical = JSON.stringify([filters.category, filters.type, filters.from?.toISOString() ?? null, filters.to?.toISOString() ?? null]);
  return crypto.createHash("sha256").update(canonical).digest("base64url").slice(0, 16);
}

export function encodeHistoryCursor(sequence, filters) {
  return Buffer.from(JSON.stringify({ s: sequence, f: filterFingerprint(filters) }), "utf8").toString("base64url");
}

/** A cursor is only valid for the filters that produced it. */
export function decodeHistoryCursor(cursor, filters) {
  if (!cursor) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
  } catch {
    throw new OperationHistoryError("Invalid cursor");
  }
  if (!data || !Number.isInteger(data.s) || data.s < 0 || data.f !== filterFingerprint(filters)) {
    throw new OperationHistoryError("Invalid cursor");
  }
  return data.s;
}

function selectedActions(filters, visibleTo) {
  return actionsWhere(
    (definition) =>
      definition.visibleTo === visibleTo &&
      (!filters.category || definition.category === filters.category) &&
      (!filters.type || definition.type === filters.type)
  );
}

async function buildVisibilityClauses(db, identities, filters) {
  const clauses = [];
  const actorActions = selectedActions(filters, "actor");
  if (actorActions.length) clauses.push({ actor: { $in: identities }, action: { $in: actorActions } });

  const subjectActions = selectedActions(filters, "subject");
  if (subjectActions.length) {
    clauses.push({ "target.type": "user", "target.id": { $in: identities }, action: { $in: subjectActions } });
  }

  const ownerActions = selectedActions(filters, "owner");
  for (const [resourceType, resolve] of Object.entries(OWNED_RESOURCE_RESOLVERS)) {
    const actions = ownerActions.filter((action) => OPERATION_HISTORY_EVENTS[action].resource === resourceType);
    if (!actions.length) continue;
    const ownedIds = await resolve(db, identities);
    if (ownedIds.length) clauses.push({ "target.type": resourceType, "target.id": { $in: ownedIds }, action: { $in: actions } });
  }
  return clauses;
}

function toObjectIds(ids) {
  return ids.filter((id) => ObjectId.isValid(id) && String(new ObjectId(id)) === id).map((id) => new ObjectId(id));
}

/** Titles for referenced materials that still exist and are not soft-deleted. */
async function loadMaterialTitles(db, records) {
  const ids = [
    ...new Set(
      records
        .filter((record) => OPERATION_HISTORY_EVENTS[record.action].resource === "material" && record.target?.type === "material")
        .map((record) => String(record.target.id))
    ),
  ];
  if (!ids.length) return new Map();
  const rows = await db
    .collection(COLLECTIONS.materials)
    .find({ _id: { $in: toObjectIds(ids) }, isDeleted: { $ne: true } }, { projection: { title: 1 } })
    .toArray();
  return new Map(rows.map((row) => [String(row._id), row.title ?? null]));
}

function toResource(definition, record, materialTitles) {
  if (!definition.resource || record.target?.type !== definition.resource) return null;
  const id = String(record.target.id);
  if (definition.resource !== "material") return { type: definition.resource, id };
  return materialTitles.has(id)
    ? { type: "material", id, title: materialTitles.get(id), available: true }
    : { type: "material", id, available: false };
}

function toHistoryEvent(record, identitySet, materialTitles) {
  const definition = OPERATION_HISTORY_EVENTS[record.action];
  const details = {};
  for (const key of definition.details) {
    const value = record.result?.[key];
    if (value !== undefined && value !== null) details[key] = value;
  }
  return {
    id: String(record._id),
    type: definition.type,
    category: definition.category,
    occurredAt: new Date(record.createdAt).toISOString(),
    performedBy: identitySet.has(String(record.actor)) ? "you" : "eduvault",
    resource: toResource(definition, record, materialTitles),
    details,
  };
}

/**
 * One page of the caller's operation history, newest first.
 * @returns {Promise<{events: object[], nextCursor: string|null, hasMore: boolean}>}
 */
export async function getOperationHistory({ db, user, query = {} }) {
  const identities = userIdentities(user);
  const { filters, limit, cursor } = parseHistoryQuery(query);
  const before = decodeHistoryCursor(cursor, filters);

  const clauses = await buildVisibilityClauses(db, identities, filters);
  if (!clauses.length) return { events: [], nextCursor: null, hasMore: false };

  const match = { $or: clauses };
  if (before !== null) match.sequence = { $lt: before };
  if (filters.from || filters.to) {
    match.createdAt = {};
    if (filters.from) match.createdAt.$gte = filters.from;
    if (filters.to) match.createdAt.$lte = filters.to;
  }

  const records = await db
    .collection(COLLECTIONS.auditLedger)
    .find(match, { projection: { _id: 1, sequence: 1, action: 1, actor: 1, target: 1, result: 1, createdAt: 1 } })
    .sort({ sequence: -1 })
    .limit(limit + 1)
    .toArray();

  const hasMore = records.length > limit;
  const page = hasMore ? records.slice(0, limit) : records;
  const materialTitles = await loadMaterialTitles(db, page);
  const identitySet = new Set(identities);

  return {
    events: page.map((record) => toHistoryEvent(record, identitySet, materialTitles)),
    nextCursor: hasMore ? encodeHistoryCursor(page.at(-1).sequence, filters) : null,
    hasMore,
  };
}
