/**
 * High-cardinality log protection for user-provided values (issue #883).
 *
 * `telemetry.js` already redacts secrets and `telemetryGuard.js` bounds metric
 * labels, but plain application logs (`logger.info({ buyerAddress }, ...)`)
 * still wrote wallet addresses, emails, URLs with query strings and raw
 * payloads verbatim. This module is installed as the pino `logMethod` hook in
 * `src/lib/logger.js`, so every log line is protected centrally rather than at
 * each of the ~100 call sites.
 *
 * Every field is classified by its key, then handled by class:
 *
 *   identifier  person-linked values (wallets, user ids, emails, IPs, tx
 *               hashes) → keyed pseudonym `<kind>#<16 hex>`. Stable for the
 *               same value, so operators can still correlate log lines.
 *   locator     URLs → origin + path with identifier-shaped segments replaced
 *               by `:id`; query string, fragment and credentials are dropped.
 *   payload     request bodies, queries, headers → `[omitted <type>:<size>]`.
 *   default     strings have identifier-shaped substrings pseudonymized.
 *
 * Structural bounds (`boundFields`) run first and secret redaction
 * (`redactSensitive`) runs last, reusing the telemetry pipeline instead of
 * duplicating it. Redaction must run after pseudonymization: it masks 64-hex
 * digests, which would otherwise collapse every tx hash into one pseudonym.
 *
 * Pseudonyms are HMAC-SHA256 keyed by `LOG_HASH_SECRET`. A plain hash would be
 * reversible by enumerating public wallet addresses. When the key is unset a
 * random per-process key is used: safe, but pseudonyms only correlate within
 * one process, so production should set it.
 *
 * Cost: one pass over the (already bounded) fields — O(n) time and space in
 * the number of logged nodes — plus O(1) cached key classification.
 */

import crypto from "node:crypto";
// telemetry.js imports logger.js, which imports this module. The cycle is safe:
// nothing here runs at load time, and logger.js only calls the hoisted
// `createLogSafetyOptions` function declaration.
import { getCorrelationId, redactSensitive } from "./telemetry.js";
import { boundFields } from "./telemetryGuard.js";

export const LOG_FIELD_CLASSES = Object.freeze({
  IDENTIFIER: "identifier",
  LOCATOR: "locator",
  PAYLOAD: "payload",
  DEFAULT: "default",
});

const PSEUDONYM_HEX_LENGTH = 16;

// Words that make a key refer to one person no matter what precedes them.
const PERSONAL_NOUNS = new Set([
  "address",
  "addresses",
  "wallet",
  "wallets",
  "publickey",
  "email",
  "emails",
  "phone",
  "ip",
  "useragent",
  "txhash",
  "transactionhash",
  "sourceaccount",
]);
// Roles whose `<role>`, `<role>Id` and `<role>Ids` keys name a person.
const PERSON_ROLES = new Set([
  "user",
  "buyer",
  "seller",
  "creator",
  "owner",
  "actor",
  "admin",
  "reviewer",
  "approver",
  "proposer",
  "invitee",
  "inviter",
  "recipient",
  "subject",
  "member",
  "student",
  "learner",
  "maintainer",
  "account",
  "external",
]);
const ID_SUFFIXES = new Set(["id", "ids", "uuid"]);
// Bare id keys nested under an identifier field, e.g. `{ user: { id } }`.
const NESTED_ID_KEYS = new Set(["id", "_id", "sub", "uuid"]);
const LOCATOR_NOUNS = new Set(["url", "uri", "href", "endpoint", "referer", "referrer"]);
const PAYLOAD_NOUNS = new Set(["body", "payload", "query", "search", "q", "headers", "params", "input", "content", "comment", "notes"]);
// Word pairs merged before matching so `publicKey` and `txHash` read as one noun.
const COMPOUND_WORDS = new Map([
  ["public", "key"],
  ["user", "agent"],
  ["tx", "hash"],
  ["transaction", "hash"],
  ["source", "account"],
]);

// Value shapes that identify one person wherever they appear in free text.
const IDENTIFIER_VALUE_PATTERNS = Object.freeze([
  { kind: "stellar", pattern: /\b(?:G[A-Z2-7]{55}|M[A-Z2-7]{68})\b/gi, normalize: (v) => v.toUpperCase() },
  { kind: "evm", pattern: /\b0x[a-fA-F0-9]{40}\b/g, normalize: (v) => v.toLowerCase() },
  { kind: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, normalize: (v) => v.toLowerCase() },
  { kind: "ip", pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, normalize: (v) => v },
]);

// URL path segments that name one entity (ids, hashes, strkeys, long tokens).
const IDENTIFIER_SEGMENT =
  /^(?:\d{4,}|[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[GMC][A-Z2-7]{55,68}|0x[a-f0-9]{40}|[A-Za-z0-9_-]{24,})$/i;

const KEY_CLASS_CACHE_LIMIT = 1024;
const keyClassCache = new Map();

let hashKey = null;

function getHashKey() {
  if (!hashKey) {
    const configured = process.env.LOG_HASH_SECRET;
    hashKey = configured && configured.trim() ? configured : crypto.randomBytes(32);
  }
  return hashKey;
}

/** Drop the cached key so a changed `LOG_HASH_SECRET` takes effect (tests, rotation). */
export function resetLogHashKey() {
  hashKey = null;
}

function splitKeyWords(key) {
  const words = String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const merged = [];
  for (let i = 0; i < words.length; i += 1) {
    if (i + 1 < words.length && COMPOUND_WORDS.get(words[i]) === words[i + 1]) {
      merged.push(words[i] + words[i + 1]);
      i += 1;
    } else {
      merged.push(words[i]);
    }
  }
  return merged;
}

/**
 * Classify a log field by its key. `actorType` stays default (a category),
 * while `actor`, `buyerAddress` and `userId` are identifiers.
 */
export function classifyLogField(key) {
  const cached = keyClassCache.get(key);
  if (cached) return cached;

  const words = splitKeyWords(key);
  const last = words.at(-1);
  let fieldClass = LOG_FIELD_CLASSES.DEFAULT;

  if (
    words.some((word) => PERSONAL_NOUNS.has(word)) ||
    (words.length === 1 && PERSON_ROLES.has(last)) ||
    (ID_SUFFIXES.has(last) && words.slice(0, -1).some((word) => PERSON_ROLES.has(word)))
  ) {
    fieldClass = LOG_FIELD_CLASSES.IDENTIFIER;
  } else if (LOCATOR_NOUNS.has(last)) {
    fieldClass = LOG_FIELD_CLASSES.LOCATOR;
  } else if (PAYLOAD_NOUNS.has(last)) {
    fieldClass = LOG_FIELD_CLASSES.PAYLOAD;
  }

  if (keyClassCache.size < KEY_CLASS_CACHE_LIMIT) keyClassCache.set(key, fieldClass);
  return fieldClass;
}

function hmacHex(value) {
  return crypto.createHmac("sha256", getHashKey()).update(value).digest("hex").slice(0, PSEUDONYM_HEX_LENGTH);
}

function detectKind(text) {
  for (const { kind, pattern, normalize } of IDENTIFIER_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    pattern.lastIndex = 0;
    if (match && match[0] === text) return { kind, normalized: normalize(text) };
  }
  return { kind: "id", normalized: text };
}

/**
 * Stable, non-reversible pseudonym for one identifier, e.g.
 * `stellar#9f2c4e1a0b7d3e55`. The same address in any casing maps to the same
 * pseudonym. Operators can compute it for a known value to search logs.
 */
export function pseudonymize(value) {
  if (value === undefined || value === null || value === "") return value;
  const text = String(value).trim();
  // Idempotent (#1086): telemetry pseudonymizes before delivery and the pino
  // hook runs again on the same line. Re-hashing a pseudonym would give the
  // same wallet two different ids in telemetry vs. plain logs.
  if (isPseudonym(text)) return text;
  const { kind, normalized } = detectKind(text);
  return `${kind}#${hmacHex(normalized)}`;
}

const PSEUDONYM_PATTERN = new RegExp(`^(?:stellar|evm|email|ip|id)#[0-9a-f]{${PSEUDONYM_HEX_LENGTH}}$`);

/** True for values already produced by `pseudonymize`. */
export function isPseudonym(value) {
  return typeof value === "string" && PSEUDONYM_PATTERN.test(value);
}

/** Replace identifier-shaped substrings (wallets, emails, IPs) inside free text. */
export function maskIdentifiersInText(text) {
  let masked = String(text);
  for (const { pattern } of IDENTIFIER_VALUE_PATTERNS) {
    masked = masked.replace(pattern, (match) => pseudonymize(match));
  }
  return masked;
}

/**
 * Reduce a URL to `origin + path`, replacing identifier-shaped path segments
 * with `:id`. Query strings and fragments routinely carry tokens and search
 * terms, and credentials must never be logged, so all three are dropped.
 */
export function sanitizeUrl(value) {
  const text = String(value);
  let parsed;
  try {
    parsed = new URL(text, "http://relative.invalid");
  } catch {
    return "[invalid-url]";
  }
  const path = parsed.pathname
    .split("/")
    .map((segment) => (IDENTIFIER_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");
  return parsed.origin === "http://relative.invalid" ? path : `${parsed.origin}${path}`;
}

function describePayload(value) {
  if (typeof value === "string") return `[omitted string:${value.length}]`;
  if (Array.isArray(value)) return `[omitted array:${value.length}]`;
  if (value && typeof value === "object") return `[omitted object:${Object.keys(value).length}]`;
  return `[omitted ${typeof value}]`;
}

function toLoggableError(error) {
  return {
    type: error.name || "Error",
    ...(error.code !== undefined ? { code: error.code } : {}),
    message: maskIdentifiersInText(error.message || ""),
    ...(error.stack ? { stack: maskIdentifiersInText(error.stack) } : {}),
  };
}

function isIdLike(value) {
  return typeof value === "object" && value !== null && typeof value.toHexString === "function";
}

function protectValue(value, fieldClass) {
  if (value === null || value === undefined) return value;
  if (fieldClass === LOG_FIELD_CLASSES.PAYLOAD) return describePayload(value);

  if (Array.isArray(value)) return value.map((entry) => protectValue(entry, fieldClass));
  if (value instanceof Error) return toLoggableError(value);
  if (isIdLike(value)) value = value.toHexString();

  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    if (fieldClass === LOG_FIELD_CLASSES.IDENTIFIER) return pseudonymize(value);
    if (fieldClass === LOG_FIELD_CLASSES.LOCATOR) return sanitizeUrl(value);
    return typeof value === "string" ? maskIdentifiersInText(value) : value;
  }

  if (typeof value === "object" && !(value instanceof Date)) {
    if (ArrayBuffer.isView(value)) return `[binary:${value.byteLength}]`;
    return protectFields(value, fieldClass);
  }
  return value;
}

function protectFields(fields, parentClass = LOG_FIELD_CLASSES.DEFAULT) {
  const output = {};
  for (const [key, value] of Object.entries(fields)) {
    const fieldClass = classifyLogField(key);
    const inheritsIdentifier =
      fieldClass === LOG_FIELD_CLASSES.DEFAULT && parentClass === LOG_FIELD_CLASSES.IDENTIFIER && NESTED_ID_KEYS.has(key);
    output[key] = protectValue(value, inheritsIdentifier ? LOG_FIELD_CLASSES.IDENTIFIER : fieldClass);
  }
  return output;
}

/**
 * Make a log context object safe to emit: bound its structure, classify and
 * pseudonymize/strip user-provided values, then redact secrets. Adds the
 * ambient correlation id so pseudonymized lines stay traceable per request.
 */
export function protectLogFields(fields) {
  if (fields === null || typeof fields !== "object") return fields;
  const source = fields instanceof Error ? { err: fields } : fields;
  const safe = redactSensitive(protectFields(boundFields(source).value));
  const correlationId = getCorrelationId();
  if (correlationId && safe.correlationId === undefined) safe.correlationId = correlationId;
  return safe;
}

/**
 * Field protection for telemetry `metadata` / `error` payloads (#1086). Same
 * classify → pseudonymize → redact pipeline as log lines, but without
 * injecting a correlation id (telemetry records carry their own). Applied in
 * `telemetry.js` before delivery, so custom sinks/exporters get the same
 * protection pino output does.
 */
export function protectTelemetryFields(fields) {
  if (fields === null || fields === undefined || typeof fields !== "object") {
    return typeof fields === "string" ? redactSensitive(maskIdentifiersInText(fields)) : fields;
  }
  return redactSensitive(protectFields(boundFields(fields).value));
}

/**
 * Protect a pino argument list: the merging object (or Error) is passed
 * through `protectLogFields`, message and interpolation strings are masked.
 */
export function protectLogArguments(args) {
  const [first, ...rest] = args;
  const protectedRest = rest.map((arg) => (typeof arg === "string" ? maskIdentifiersInText(arg) : protectLogFields(arg)));

  if (first !== null && typeof first === "object") return [protectLogFields(first), ...protectedRest];

  const message = typeof first === "string" ? maskIdentifiersInText(first) : first;
  const correlationId = getCorrelationId();
  return correlationId ? [{ correlationId }, message, ...protectedRest] : [message, ...protectedRest];
}

/** pino `hooks.logMethod` implementation. Must be a non-arrow function so pino's `this` is kept. */
export function protectLogMethod(args, method) {
  return method.apply(this, protectLogArguments(args));
}

/** pino options that install the protection on a logger instance. */
export function createLogSafetyOptions() {
  return {
    hooks: { logMethod: protectLogMethod },
    // The hook already reduced errors to safe { type, code, message, stack }
    // objects; pino's default err serializer would relabel them as "Object".
    serializers: { err: (err) => err },
  };
}
