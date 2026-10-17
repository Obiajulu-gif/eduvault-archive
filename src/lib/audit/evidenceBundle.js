/**
 * src/lib/audit/evidenceBundle.js
 *
 * Privacy-preserving audit evidence bundles for support investigations (#943).
 *
 * A support investigation ("why was this learner charged twice?", "why did the
 * creator payout not arrive?") needs a portable record of what the system did.
 * Raw audit rows are unsafe to hand around: they carry wallet addresses,
 * emails, JWTs, signed XDR and free-text notes. This module turns a list of
 * audit events into an exportable bundle that:
 *
 *   - drops secrets entirely (no hash, no prefix — nothing to brute force),
 *   - replaces PII with keyed HMAC pseudonyms, so the same learner can be
 *     correlated across events inside one bundle without being identified,
 *   - keeps identifiers, timestamps, amounts and on-chain hashes verbatim so
 *     behavior can be checked against MongoDB, Horizon or IPFS,
 *   - commits to every original payload with a keyed digest, so an operator
 *     holding the bundle key can later prove a bundle matches source rows,
 *   - links entries into a hash chain with a root hash, so tampering with,
 *     reordering or dropping entries is detectable by anyone (no key needed).
 *
 * The module is pure: no database or network access. Callers load the events
 * (from the audit ledger, outbox, purchases...) and decide where to store the
 * bundle. See docs/audit-evidence-bundles.md for operational guidance.
 */

import crypto from 'node:crypto';

export const EVIDENCE_BUNDLE_SCHEMA_VERSION = 1;
export const REDACTION_POLICY_VERSION = 'evidence-redaction-v1';
export const DEFAULT_MAX_EVENTS = 5000;
export const MIN_BUNDLE_KEY_LENGTH = 32;

export const SECRET_MARKER = '[REDACTED:secret]';
export const FREE_TEXT_MARKER = '[REDACTED:free-text]';
export const GENESIS_HASH = '0'.repeat(64);

export class EvidenceBundleError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'EvidenceBundleError';
    this.code = code;
  }
}

// Values under these keys are dropped outright.
const SECRET_KEY_PATTERN =
  /pass(word|phrase)?|secret|token|jwt|authorization|bearer|cookie|api[-_]?key|private[-_]?key|seed|mnemonic|recovery[-_]?phrase|signed[-_]?xdr|envelope[-_]?xdr|signature|otp|cvv|cvc|card[-_]?number/i;

// Values under these keys identify a person and are pseudonymized.
const PII_KEY_PATTERN =
  /e-?mail|wallet|address|account|full[-_]?name|first[-_]?name|last[-_]?name|display[-_]?name|phone|^ip$|^ip[-_]?addr(ess)?$|[a-z]Ip$|IpAddress$|user[-_]?agent|buyer|seller|learner|recipient|payer|payee/i;

// Free text can hold anything a user typed; it is never exported.
const FREE_TEXT_KEY_PATTERN = /note|comment|message|reason|description|body|text|feedback/i;

// Keys preserved verbatim because they are needed to verify behavior. These
// win over the PII and free-text patterns (contract IDs are public, wallets
// are not). String values are still scanned for inline secret/PII shapes.
const VERIFIABLE_KEY_PATTERN =
  /(^|[-_])(id|ids)$|Id$|Ids$|^_id$|hash$|Hash$|^cid$|Cid$|^status$|^state$|^type$|^event$|^action$|^operation$|^network$|^asset$|^currency$|^amount$|Amount$|^fee$|Fee$|^ledger$|^sequence$|^version$|^attempts?$|^role$|^result$|^code$|At$|^at$|^timestamp$|^date$|contractId$|ContractId$|contractAddress$|ContractAddress$/;

// Shapes masked wherever they appear in strings that survive redaction.
const SECRET_VALUE_PATTERNS = Object.freeze([
  /\bS[A-Z2-7]{55}\b/g, // Stellar secret seed
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
]);
const PII_VALUE_PATTERNS = Object.freeze([
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // email
  /\bG[A-Z2-7]{55}\b/g, // Stellar public account (wallet)
  /\b0x[a-fA-F0-9]{40}\b/g, // legacy EVM wallet
]);

const MAX_DEPTH = 8;

/** Deterministic JSON: sorted keys, Dates as ISO, bigint as string. */
export function stableStringify(value) {
  return JSON.stringify(toStable(value));
}

function toStable(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toStable);
  if (typeof value.toHexString === 'function') return value.toHexString(); // ObjectId
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined || typeof value[key] === 'function') continue;
    out[key] = toStable(value[key]);
  }
  return out;
}

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function hmacHex(key, input) {
  return crypto.createHmac('sha256', key).update(input).digest('hex');
}

function assertBundleKey(key) {
  if (typeof key !== 'string' || key.length < MIN_BUNDLE_KEY_LENGTH) {
    throw new EvidenceBundleError(
      `Evidence bundle key must be a string of at least ${MIN_BUNDLE_KEY_LENGTH} characters.`,
      'INVALID_BUNDLE_KEY'
    );
  }
}

function toIsoTimestamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Build a redactor bound to one bundle key. Pseudonyms are stable inside a
 * bundle (same key) and unlinkable across bundles built with different keys.
 */
export function createRedactor(bundleKey) {
  assertBundleKey(bundleKey);
  const summary = { secrets: 0, pii: 0, freeText: 0, maskedInline: 0 };

  const pseudonym = (value) => {
    summary.pii += 1;
    return `pii:${hmacHex(bundleKey, `pii|${String(value).trim().toLowerCase()}`).slice(0, 16)}`;
  };

  const maskString = (value) => {
    let out = value;
    for (const pattern of SECRET_VALUE_PATTERNS) {
      out = out.replace(pattern, () => {
        summary.maskedInline += 1;
        return SECRET_MARKER;
      });
    }
    for (const pattern of PII_VALUE_PATTERNS) {
      out = out.replace(pattern, (match) => {
        summary.maskedInline += 1;
        return pseudonym(match);
      });
    }
    return out;
  };

  const redactValue = (value, key, depth) => {
    if (value == null) return value ?? null;
    if (key != null) {
      const name = String(key);
      if (SECRET_KEY_PATTERN.test(name)) {
        summary.secrets += 1;
        return SECRET_MARKER;
      }
      if (!VERIFIABLE_KEY_PATTERN.test(name)) {
        if (PII_KEY_PATTERN.test(name) && (typeof value !== 'object' || value instanceof Date)) {
          return pseudonym(value instanceof Date ? value.toISOString() : value);
        }
        if (FREE_TEXT_KEY_PATTERN.test(name) && typeof value === 'string') {
          summary.freeText += 1;
          return FREE_TEXT_MARKER;
        }
      }
    }
    if (typeof value === 'string') return maskString(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'function' || typeof value === 'symbol') return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value.toHexString === 'function') return value.toHexString();
    if (depth >= MAX_DEPTH) return '[TRUNCATED]';
    if (Array.isArray(value)) return value.map((entry) => redactValue(entry, key, depth + 1));
    const out = {};
    for (const childKey of Object.keys(value).sort()) {
      out[childKey] = redactValue(value[childKey], childKey, depth + 1);
    }
    return out;
  };

  return {
    redact: (value) => redactValue(value, null, 0),
    pseudonym,
    summary,
  };
}

function entryHash(entry) {
  const { entryHash: _ignored, ...rest } = entry;
  return sha256Hex(stableStringify(rest));
}

/**
 * Build an exportable evidence bundle.
 *
 * @param {object} input
 * @param {string} input.investigationId  Support ticket / case id (kept verbatim).
 * @param {Array<object>} input.events    Audit events: { id|_id|eventId, type, occurredAt|createdAt|timestamp, ...payload }.
 * @param {string} input.bundleKey        Server-side secret (>= 32 chars) used for pseudonyms and payload digests.
 * @param {object} [input.requestedBy]    Operator; only id and role are retained.
 * @param {object} [input.subject]        Subject of the investigation (pseudonymized).
 * @param {Date|string} [input.now]
 * @param {number} [input.maxEvents]
 * @param {boolean} [input.allowPartial]  When false (default) any invalid event aborts the export.
 */
export function buildEvidenceBundle({
  investigationId,
  events,
  bundleKey,
  requestedBy = null,
  subject = null,
  now = new Date(),
  maxEvents = DEFAULT_MAX_EVENTS,
  allowPartial = false,
} = {}) {
  assertBundleKey(bundleKey);
  if (typeof investigationId !== 'string' || !investigationId.trim()) {
    throw new EvidenceBundleError('investigationId is required.', 'MISSING_INVESTIGATION_ID');
  }
  if (!Array.isArray(events)) {
    throw new EvidenceBundleError('events must be an array.', 'INVALID_EVENTS');
  }
  if (events.length > maxEvents) {
    throw new EvidenceBundleError(
      `Refusing to export ${events.length} events (limit ${maxEvents}); narrow the investigation window.`,
      'TOO_MANY_EVENTS'
    );
  }
  const createdAt = toIsoTimestamp(now);
  if (!createdAt) throw new EvidenceBundleError('now must be a valid date.', 'INVALID_NOW');

  const redactor = createRedactor(bundleKey);
  const omitted = [];
  const normalized = [];
  const seenIds = new Set();

  events.forEach((event, index) => {
    const rawId = event?.eventId ?? event?.id ?? event?._id;
    const eventId = rawId == null ? null : String(typeof rawId.toHexString === 'function' ? rawId.toHexString() : rawId);
    const occurredAt = toIsoTimestamp(event?.occurredAt ?? event?.createdAt ?? event?.timestamp);
    let reason = null;
    if (!event || typeof event !== 'object') reason = 'not_an_object';
    else if (!eventId) reason = 'missing_event_id';
    else if (!occurredAt) reason = 'missing_or_invalid_timestamp';
    else if (seenIds.has(eventId)) reason = 'duplicate_event_id';

    if (reason) {
      if (!allowPartial) {
        throw new EvidenceBundleError(`Event at index ${index} rejected: ${reason}.`, 'INVALID_EVENT');
      }
      omitted.push({ index, eventId, reason });
      return;
    }
    seenIds.add(eventId);
    normalized.push({ index, eventId, occurredAt, event });
  });

  // Chronological order, ties broken by id, so rebuilding yields the same chain.
  normalized.sort((a, b) =>
    a.occurredAt === b.occurredAt
      ? a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0
      : a.occurredAt < b.occurredAt ? -1 : 1
  );

  let prevHash = GENESIS_HASH;
  const entries = normalized.map(({ eventId, occurredAt, event }, seq) => {
    const { _id, id, eventId: _e, occurredAt: _o, createdAt: _c, timestamp: _t, type, ...payload } = event;
    const entry = {
      seq,
      eventId,
      type: typeof type === 'string' ? type : 'unknown',
      occurredAt,
      payload: redactor.redact(payload),
      payloadDigest: hmacHex(bundleKey, `payload|${stableStringify(event)}`),
      prevHash,
    };
    entry.entryHash = entryHash(entry);
    prevHash = entry.entryHash;
    return entry;
  });

  const manifest = {
    schemaVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION,
    redactionPolicy: REDACTION_POLICY_VERSION,
    investigationId: investigationId.trim(),
    createdAt,
    requestedBy: requestedBy
      ? { id: requestedBy.id == null ? null : String(requestedBy.id), role: requestedBy.role ?? null }
      : null,
    subject: subject == null ? null : redactor.pseudonym(typeof subject === 'object' ? stableStringify(subject) : subject),
    eventCount: entries.length,
    omittedCount: omitted.length,
    window: entries.length
      ? { from: entries[0].occurredAt, to: entries[entries.length - 1].occurredAt }
      : null,
    rootHash: prevHash,
    keyFingerprint: hmacHex(bundleKey, 'fingerprint').slice(0, 16),
    redactionSummary: { ...redactor.summary },
  };

  return { manifest, entries, omitted, manifestHash: sha256Hex(stableStringify(manifest)) };
}

/**
 * Verify a bundle's integrity without the bundle key: hash chain, root hash,
 * manifest hash, counts, and a leak scan for secret / PII shapes.
 * Pass `bundleKey` + `sourceEvents` to also prove entries match source rows.
 */
export function verifyEvidenceBundle(bundle, { bundleKey, sourceEvents } = {}) {
  const errors = [];
  if (!bundle || typeof bundle !== 'object' || !bundle.manifest || !Array.isArray(bundle.entries)) {
    return { valid: false, errors: ['malformed_bundle'] };
  }
  const { manifest, entries } = bundle;

  if (manifest.schemaVersion !== EVIDENCE_BUNDLE_SCHEMA_VERSION) {
    errors.push(`unsupported_schema_version:${manifest.schemaVersion}`);
  }
  if (sha256Hex(stableStringify(manifest)) !== bundle.manifestHash) errors.push('manifest_hash_mismatch');
  if (manifest.eventCount !== entries.length) errors.push('event_count_mismatch');

  let prevHash = GENESIS_HASH;
  entries.forEach((entry, i) => {
    if (entry.seq !== i) errors.push(`sequence_gap:${i}`);
    if (entry.prevHash !== prevHash) errors.push(`chain_broken:${i}`);
    if (entryHash(entry) !== entry.entryHash) errors.push(`entry_hash_mismatch:${i}`);
    prevHash = entry.entryHash;
  });
  if (prevHash !== manifest.rootHash) errors.push('root_hash_mismatch');

  const serialized = JSON.stringify(entries);
  for (const pattern of [...SECRET_VALUE_PATTERNS, ...PII_VALUE_PATTERNS]) {
    if (new RegExp(pattern.source, pattern.flags.replace('g', '')).test(serialized)) {
      errors.push(`leak_detected:${pattern.source.slice(0, 24)}`);
    }
  }

  if (bundleKey && Array.isArray(sourceEvents)) {
    assertBundleKey(bundleKey);
    if (hmacHex(bundleKey, 'fingerprint').slice(0, 16) !== manifest.keyFingerprint) {
      errors.push('bundle_key_mismatch');
    } else {
      const byId = new Map(
        sourceEvents.map((event) => {
          const rawId = event?.eventId ?? event?.id ?? event?._id;
          return [String(typeof rawId?.toHexString === 'function' ? rawId.toHexString() : rawId), event];
        })
      );
      for (const entry of entries) {
        const source = byId.get(entry.eventId);
        if (!source) errors.push(`source_missing:${entry.eventId}`);
        else if (hmacHex(bundleKey, `payload|${stableStringify(source)}`) !== entry.payloadDigest) {
          errors.push(`source_mismatch:${entry.eventId}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
