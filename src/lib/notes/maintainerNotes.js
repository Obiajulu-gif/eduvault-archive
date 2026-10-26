import crypto from "node:crypto";

export const NOTE_TYPES = Object.freeze({
  INCIDENT: "incident",
  MODERATION: "moderation",
  SUPPORT: "support",
  SECURITY: "security",
  OPERATIONS: "operations",
});

export const NOTE_VISIBILITY = Object.freeze({ PRIVATE: "private", TEAM: "team", ADMINS: "admins" });
export const NOTE_STATES = Object.freeze({ ACTIVE: "active", REDACTED: "redacted", ARCHIVED: "archived" });
export const NOTE_RETENTION_DAYS = Object.freeze({
  [NOTE_TYPES.INCIDENT]: 365,
  [NOTE_TYPES.MODERATION]: 180,
  [NOTE_TYPES.SUPPORT]: 90,
  [NOTE_TYPES.SECURITY]: 730,
  [NOTE_TYPES.OPERATIONS]: 90,
});
const MAINTAINER_ROLES = new Set(["admin", "support"]);

export class MaintainerNoteError extends Error {
  constructor(message, code = "NOTE_INVALID", status = 400) {
    super(message); this.name = "MaintainerNoteError"; this.code = code; this.status = status;
  }
}

function requireMaintainer(actor) {
  if (!actor) throw new MaintainerNoteError("Authentication required.", "NOTE_UNAUTHENTICATED", 401);
  if (!MAINTAINER_ROLES.has(actor.role)) throw new MaintainerNoteError("Maintainer access required.", "NOTE_FORBIDDEN", 403);
}
function nowDate(value) { const date = new Date(value ?? Date.now()); if (Number.isNaN(date.getTime())) throw new MaintainerNoteError("Invalid timestamp."); return date; }
function audit(note, action, actor, at, extra = {}) {
  return { event: `maintainer_note.${action}`, noteId: note.id, actorId: String(actor.id ?? actor.sub ?? actor.walletAddress), targetId: note.targetId, at: at.toISOString(), ...extra };
}

export function createMaintainerNote({ actor, targetId, type, visibility = NOTE_VISIBILITY.PRIVATE, body, now, retentionDays } = {}) {
  requireMaintainer(actor);
  if (!targetId || typeof targetId !== "string") throw new MaintainerNoteError("targetId is required.");
  if (!Object.values(NOTE_TYPES).includes(type)) throw new MaintainerNoteError("Unknown note type.");
  if (!Object.values(NOTE_VISIBILITY).includes(visibility)) throw new MaintainerNoteError("Unknown note visibility.");
  if (typeof body !== "string" || !body.trim()) throw new MaintainerNoteError("Note body is required.");
  const createdAt = nowDate(now);
  const days = retentionDays ?? NOTE_RETENTION_DAYS[type];
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new MaintainerNoteError("Retention must be between 1 and 3650 days.");
  const note = {
    id: crypto.randomUUID(), targetId, type, visibility, body: body.trim().slice(0, 10000),
    state: NOTE_STATES.ACTIVE, authorId: String(actor.id ?? actor.sub ?? actor.walletAddress),
    createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString(),
    retentionDays: days, expiresAt: new Date(createdAt.getTime() + days * 86400000).toISOString(),
    audit: [],
  };
  note.audit.push(audit(note, "created", actor, createdAt));
  return note;
}

export function canViewMaintainerNote(note, actor, now) {
  if (!note || note.state === NOTE_STATES.ARCHIVED) return false;
  if (new Date(now ?? Date.now()) >= new Date(note.expiresAt)) return false;
  if (!actor || !MAINTAINER_ROLES.has(actor.role)) return false;
  if (note.visibility === NOTE_VISIBILITY.ADMINS) return actor.role === "admin";
  if (note.visibility === NOTE_VISIBILITY.PRIVATE) return String(actor.id ?? actor.sub ?? actor.walletAddress) === note.authorId || actor.role === "admin";
  return true;
}

export function editMaintainerNote(note, { actor, body, visibility, now } = {}) {
  requireMaintainer(actor);
  if (!note || note.state !== NOTE_STATES.ACTIVE) throw new MaintainerNoteError("Only active notes can be edited.", "NOTE_NOT_EDITABLE", 409);
  const actorId = String(actor.id ?? actor.sub ?? actor.walletAddress);
  if (actor.role !== "admin" && actorId !== note.authorId) throw new MaintainerNoteError("Only the author or an admin may edit this note.", "NOTE_FORBIDDEN", 403);
  if (body !== undefined && (typeof body !== "string" || !body.trim())) throw new MaintainerNoteError("Note body is required.");
  const at = nowDate(now);
  const updated = { ...note, ...(body === undefined ? {} : { body: body.trim().slice(0, 10000) }), ...(visibility === undefined ? {} : { visibility }), updatedAt: at.toISOString(), audit: [...(note.audit ?? []), audit(note, "edited", actor, at)] };
  return updated;
}

export function redactMaintainerNote(note, { actor, now } = {}) {
  requireMaintainer(actor);
  if (actor.role !== "admin") throw new MaintainerNoteError("Only admins may redact notes.", "NOTE_FORBIDDEN", 403);
  const at = nowDate(now);
  return { ...note, body: "[REDACTED]", state: NOTE_STATES.REDACTED, updatedAt: at.toISOString(), redactedAt: at.toISOString(), audit: [...(note.audit ?? []), audit(note, "redacted", actor, at)] };
}

export function archiveMaintainerNote(note, { actor, now } = {}) {
  requireMaintainer(actor);
  if (actor.role !== "admin" && String(actor.id ?? actor.sub ?? actor.walletAddress) !== note.authorId) throw new MaintainerNoteError("Only the author or an admin may archive this note.", "NOTE_FORBIDDEN", 403);
  const at = nowDate(now);
  return { ...note, state: NOTE_STATES.ARCHIVED, archivedAt: at.toISOString(), updatedAt: at.toISOString(), audit: [...(note.audit ?? []), audit(note, "archived", actor, at)] };
}

export function expireMaintainerNote(note, { now } = {}) {
  if (note.state === NOTE_STATES.ARCHIVED || new Date(now ?? Date.now()) < new Date(note.expiresAt)) return note;
  const at = nowDate(now);
  return { ...note, state: NOTE_STATES.ARCHIVED, archivedAt: at.toISOString(), archiveReason: "retention_expired", updatedAt: at.toISOString(), audit: [...(note.audit ?? []), { event: "maintainer_note.expired", noteId: note.id, at: at.toISOString() }] };
}
