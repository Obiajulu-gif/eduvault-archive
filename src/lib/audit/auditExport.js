import crypto from "node:crypto";
import { canonicalize } from "../backend/auditLedger.js";

export const AUDIT_EXPORT_SCHEMA_VERSION = "1.0.0";
export const AuditExportProfile = Object.freeze({
  FULL: "full",
  SECURITY: "security_incident",
  OPERATIONS: "operations",
  PRIVACY: "privacy_review",
});

const STAFF_ROLES = new Set(["admin", "support", "auditor"]);
const REDACTED = "[REDACTED]";
const SECRET_KEY = /(password|secret|token|credential|private.?key|seed|authorization|cookie)/i;
const PROFILE_RULES = Object.freeze({
  [AuditExportProfile.FULL]: new Set(),
  [AuditExportProfile.SECURITY]: new Set(["actorProof", "before.email", "after.email"]),
  [AuditExportProfile.OPERATIONS]: new Set(["actorProof", "before.email", "after.email", "before.walletAddress", "after.walletAddress"]),
  [AuditExportProfile.PRIVACY]: new Set(["actorProof", "actor", "before", "after", "intentHash"]),
});

export class AuditExportAuthorizationError extends Error {
  constructor(message, code = "AUDIT_EXPORT_FORBIDDEN", status = 403) {
    super(message);
    this.name = "AuditExportAuthorizationError";
    this.code = code;
    this.status = status;
  }
}

function assertAuthorized(actor, profile) {
  if (!actor) throw new AuditExportAuthorizationError("Authentication required.", "AUDIT_EXPORT_UNAUTHENTICATED", 401);
  if (!STAFF_ROLES.has(actor.role)) throw new AuditExportAuthorizationError("Only authorized staff may export audit records.");
  if (profile === AuditExportProfile.FULL && actor.role !== "admin") {
    throw new AuditExportAuthorizationError("Full audit exports require administrator access.");
  }
}

function redactValue(value, path, rules) {
  if (SECRET_KEY.test(path)) return REDACTED;
  if (rules.has(path) || [...rules].some((rule) => path.startsWith(`${rule}.`))) return REDACTED;
  if (Array.isArray(value)) return value.map((item, index) => redactValue(item, `${path}[${index}]`, rules));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, redactValue(item, path ? `${path}.${key}` : key, rules)]));
  }
  return value;
}

export function redactAuditRecord(record, profile = AuditExportProfile.SECURITY) {
  if (!PROFILE_RULES[profile]) throw new Error(`Unknown audit export profile: ${profile}`);
  return redactValue(record, "", PROFILE_RULES[profile]);
}

export function buildAuditExport({ actor, records = [], profile = AuditExportProfile.SECURITY, purpose = "general_audit", generatedAt = new Date() } = {}) {
  assertAuthorized(actor, profile);
  if (!Array.isArray(records)) throw new TypeError("records must be an array");
  const generated = new Date(generatedAt);
  if (Number.isNaN(generated.getTime())) throw new TypeError("generatedAt must be a valid date");
  const exportedRecords = records.map((record) => redactAuditRecord(record, profile));
  const contentHash = crypto.createHash("sha256").update(canonicalize(exportedRecords)).digest("hex");
  const exportDoc = {
    schemaVersion: AUDIT_EXPORT_SCHEMA_VERSION,
    exportId: crypto.createHash("sha256").update(`${generated.toISOString()}:${profile}:${contentHash}`).digest("hex").slice(0, 32),
    generatedAt: generated.toISOString(),
    profile,
    purpose: String(purpose).slice(0, 200),
    records: exportedRecords,
    verification: {
      algorithm: "sha256",
      contentHash,
      recordCount: exportedRecords.length,
      sourceLedgerVersion: records[0]?.version || null,
    },
  };
  return Object.freeze(exportDoc);
}

export function verifyAuditExport(exportDoc) {
  if (!exportDoc || exportDoc.schemaVersion !== AUDIT_EXPORT_SCHEMA_VERSION || !Array.isArray(exportDoc.records)) return { valid: false, reason: "invalid_schema" };
  const contentHash = crypto.createHash("sha256").update(canonicalize(exportDoc.records)).digest("hex");
  return {
    valid: contentHash === exportDoc.verification?.contentHash && exportDoc.verification?.recordCount === exportDoc.records.length,
    contentHash,
    expectedHash: exportDoc.verification?.contentHash || null,
  };
}
