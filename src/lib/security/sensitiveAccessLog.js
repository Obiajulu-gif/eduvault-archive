import crypto from "node:crypto";

/**
 * Sensitive-field access logging with anomaly detection hooks.
 *
 * The logger records *which* sensitive fields were touched, never what they
 * contained. Every event is built through `buildSensitiveAccessEvent`, which
 * only keeps field names (strings) and drops anything value-shaped, so a
 * caller cannot accidentally persist a secret by passing a richer object.
 *
 * The module is intentionally dependency-free and injectable: the sink and the
 * `onAnomaly` hook are functions supplied by the caller, so tests run without a
 * live database and production can point the sink at the tamper-evident
 * `audit_ledger`.
 */

export const SENSITIVE_ACCESS_COLLECTION = "sensitive_access_log";

export const ACCESS_DECISIONS = Object.freeze(["allowed", "denied"]);

/**
 * Inventory of field families that must never have their values logged. This
 * is documentation as much as configuration: it is exported so the inventory
 * can be asserted and rendered by maintainer tooling.
 */
export const SENSITIVE_FIELDS = Object.freeze([
  "fullName",
  "email",
  "phone",
  "phoneNumber",
  "dateOfBirth",
  "dob",
  "ssn",
  "nationalId",
  "passportNumber",
  "taxId",
  "password",
  "passwordHash",
  "currentPassword",
  "newPassword",
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "apiKey",
  "apiSecret",
  "secret",
  "clientSecret",
  "privateKey",
  "walletPrivateKey",
  "seedPhrase",
  "mnemonic",
  "recoveryPhrase",
  "creditCard",
  "cardNumber",
  "cvv",
  "cvc",
  "iban",
  "bankAccount",
  "routingNumber",
  "signature",
  "authorization",
]);

const REDACTED = "[redacted]";
const INVALID_FIELD_NAME = "[invalid-field-name]";
const FIELD_NAME_PATTERN = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const FIELD_NAME_MAX_LENGTH = 120;

/**
 * Matches a key that could carry a secret, a credential, or personal data.
 * Substring matching is deliberate: `passwordHash`, `userEmail`, and
 * `accessTokenValue` are all caught even though only part of the key is
 * sensitive.
 */
const SENSITIVE_KEY_PATTERN =
  /(pass|secret|token|api[-_]?key|private[-_]?key|seed|mnemonic|recovery|ssn|social|national|passport|tax[-_]?id|name|email|phone|mobile|dob|birth|credit|card|cvv|cvc|iban|bank|routing|authorization|signature|value)/i;

function toIsoString(value) {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/**
 * Reduce one raw field reference to a safe name. Objects are accepted only for
 * their name/subject; any sibling `value` is discarded by construction.
 */
export function sanitizeFieldName(raw) {
  let candidate = raw;
  if (candidate && typeof candidate === "object") {
    candidate = candidate.name ?? candidate.field ?? candidate.key ?? candidate.path ?? null;
  }
  if (typeof candidate !== "string") return INVALID_FIELD_NAME;
  const trimmed = candidate.trim().slice(0, FIELD_NAME_MAX_LENGTH);
  return FIELD_NAME_PATTERN.test(trimmed) ? trimmed : INVALID_FIELD_NAME;
}

/**
 * Normalize a field list to unique, sorted, value-free names.
 */
export function sanitizeFieldNames(fields) {
  const list = fields == null ? [] : Array.isArray(fields) ? fields : [fields];
  return Object.freeze([...new Set(list.map(sanitizeFieldName))].sort());
}

/**
 * Recursively redact a payload. Any key that looks sensitive has its value
 * replaced with a constant marker, so no secret, token, or PII value can ever
 * survive into a stored event.
 */
export function redactSensitivePayload(value) {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(redactSensitivePayload);
  const redacted = {};
  for (const [key, nested] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactSensitivePayload(nested);
  }
  return redacted;
}

export const REDACTED_VALUE = REDACTED;

export function redactSensitiveValue() {
  return REDACTED;
}

function generateCorrelationId() {
  return crypto.randomUUID();
}

/**
 * Build the canonical sensitive-access event. Values never enter this shape:
 * `fields` is normalized to names and optional `metadata` is redacted.
 */
export function buildSensitiveAccessEvent({
  actorId,
  actorType = "user",
  purpose,
  resourceType,
  resourceId,
  fields = [],
  decision,
  at = new Date(),
  correlationId,
  metadata = null,
} = {}) {
  if (!ACCESS_DECISIONS.includes(decision)) {
    throw new Error(`Invalid sensitive access decision: ${String(decision)}`);
  }
  if (!actorId) throw new Error("actorId is required for a sensitive access event");
  if (!resourceType || !resourceId) {
    throw new Error("resourceType and resourceId are required for a sensitive access event");
  }

  const event = {
    actorId: String(actorId),
    actorType: String(actorType || "user"),
    purpose: purpose ? String(purpose) : "unspecified",
    resourceType: String(resourceType),
    resourceId: String(resourceId),
    fields: sanitizeFieldNames(fields),
    decision,
    at: toIsoString(at),
    correlationId: correlationId ? String(correlationId) : generateCorrelationId(),
  };
  if (metadata) event.metadata = redactSensitivePayload(metadata);
  return Object.freeze(event);
}

export const DEFAULT_ANOMALY_THRESHOLDS = Object.freeze({
  windowMs: 60_000,
  bulkFieldCount: 10,
  bulkResourceCount: 5,
  denialCount: 5,
});

function freezeSignal(signal) {
  return Object.freeze(signal);
}

/**
 * Pure anomaly detector. Returns bounded, value-free signals describing bulk
 * access or repeated denials inside the window. It only reports counts,
 * thresholds, and the actor id — never a field value.
 */
export function detectAccessAnomalies(events, { thresholds = {}, now = new Date() } = {}) {
  const config = { ...DEFAULT_ANOMALY_THRESHOLDS, ...thresholds };
  const nowMs = toMillis(now);
  const windowStart = nowMs - config.windowMs;

  const recent = (Array.isArray(events) ? events : []).filter((event) => {
    const at = Date.parse(event?.at);
    return Number.isFinite(at) && at > windowStart && at <= nowMs;
  });
  if (recent.length === 0) return [];

  const byActor = new Map();
  for (const event of recent) {
    const key = String(event.actorId);
    if (!byActor.has(key)) byActor.set(key, []);
    byActor.get(key).push(event);
  }

  const signals = [];
  for (const [actorId, actorEvents] of byActor) {
    const fields = new Set();
    const resources = new Set();
    let denials = 0;
    for (const event of actorEvents) {
      if (event.decision === "denied") denials += 1;
      if (event.decision !== "allowed") continue;
      for (const field of event.fields || []) fields.add(field);
      resources.add(`${event.resourceType}:${event.resourceId}`);
    }

    if (fields.size > config.bulkFieldCount || resources.size > config.bulkResourceCount) {
      signals.push(
        freezeSignal({
          type: "bulk_access",
          severity: resources.size > config.bulkResourceCount ? "high" : "medium",
          actorId,
          fieldCount: fields.size,
          resourceCount: resources.size,
          windowMs: config.windowMs,
          threshold: { fields: config.bulkFieldCount, resources: config.bulkResourceCount },
        }),
      );
    }

    if (denials >= config.denialCount) {
      signals.push(
        freezeSignal({
          type: "repeated_denials",
          severity: "high",
          actorId,
          denialCount: denials,
          windowMs: config.windowMs,
          threshold: config.denialCount,
        }),
      );
    }
  }
  return signals;
}

export class SensitiveAccessDeniedError extends Error {
  constructor(event, signals = []) {
    super(`Sensitive access denied for ${event.resourceType}:${event.resourceId}`);
    this.name = "SensitiveAccessDeniedError";
    this.code = "SENSITIVE_ACCESS_DENIED";
    this.event = event;
    this.signals = signals;
  }
}

/**
 * Create a logger bound to a sink and an anomaly hook.
 *
 * `record` persists the event before applying any fail-closed behavior, so a
 * denied attempt is always auditable. When the decision is `denied`, `record`
 * throws `SensitiveAccessDeniedError` after the sink and hooks have run —
 * callers cannot continue on a denied access.
 */
export function createSensitiveAccessLogger({
  sink = async () => {},
  onAnomaly = () => {},
  thresholds = {},
  now = () => new Date(),
  historyLimit = 1000,
} = {}) {
  if (typeof sink !== "function") throw new Error("sink must be a function");
  if (typeof onAnomaly !== "function") throw new Error("onAnomaly must be a function");
  if (!Number.isInteger(historyLimit) || historyLimit <= 0) {
    throw new Error("historyLimit must be a positive integer");
  }

  const config = { ...DEFAULT_ANOMALY_THRESHOLDS, ...thresholds };
  const history = [];

  async function record(input = {}) {
    const event = buildSensitiveAccessEvent({ ...input, at: input.at ?? now() });
    history.push(event);
    if (history.length > historyLimit) history.splice(0, history.length - historyLimit);

    // Persist first: a denied attempt must leave an audit trail even though the
    // caller is about to be stopped.
    await sink(event);

    const signals = detectAccessAnomalies(history, { thresholds: config, now: event.at });
    for (const signal of signals) {
      await onAnomaly(signal, event);
    }

    if (event.decision === "denied") {
      throw new SensitiveAccessDeniedError(event, signals);
    }
    return { event, signals };
  }

  return {
    record,
    getHistory: () => [...history],
    thresholds: Object.freeze({ ...config }),
  };
}

/**
 * Adapter that forwards safe events into the existing tamper-evident audit
 * ledger. `appendRecord` is injected (defaulting to no ledger import) so this
 * module stays free of database coupling and test mocks.
 */
export function createAuditLedgerSink({ db, appendRecord, action = "sensitive_field_access" } = {}) {
  if (!db) throw new Error("db is required for the audit ledger sink");
  if (typeof appendRecord !== "function") throw new Error("appendRecord must be a function");
  return async (event) => {
    await appendRecord({
      db,
      operationId: `sensitive-access:${event.correlationId}`,
      actor: event.actorId,
      actorContext: { actorType: event.actorType },
      action,
      target: { type: event.resourceType, id: event.resourceId },
      result: { decision: event.decision, fields: event.fields },
      reason: event.purpose,
      intent: { purpose: event.purpose, actorType: event.actorType, fields: event.fields },
    });
  };
}
