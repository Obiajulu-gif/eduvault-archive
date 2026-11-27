/**
 * src/lib/audit/auditReceipts.js
 *
 * Signed audit receipts for privileged actions (#1082).
 *
 * The audit ledger (`backend/auditLedger.js`) is a hash chain: tampering with
 * a stored record is detectable by anyone who can read the whole chain. A
 * receipt is portable proof of one privileged action that can be handed to
 * the affected user, a reviewer, or an incident report and checked later
 * without trusting whoever relays it:
 *
 *   receipt = { operationId, sequence, recordHash, action, actor, ... }
 *             + HMAC-SHA256(canonical(receipt), key[keyId])
 *
 * Because it embeds `recordHash`, a valid receipt also pins the exact ledger
 * record, so a rewritten ledger entry no longer matches its receipt.
 *
 * Keys
 *   AUDIT_RECEIPT_KEYS             "kid1:<base64 secret>,kid2:<base64 secret>"
 *   AUDIT_RECEIPT_ACTIVE_KEY_ID    kid used to sign new receipts
 *   AUDIT_RECEIPT_REVOKED_KEY_IDS  optional "kid1,kid3"
 *   Rotation keeps old kids in AUDIT_RECEIPT_KEYS so older receipts still
 *   verify. Revoking a kid makes every receipt signed with it fail.
 *
 * Failure behavior
 *   - No keys configured -> issuing fails closed (SERVICE_UNAVAILABLE). The
 *     privileged action itself is already recorded in the ledger; a receipt
 *     can be issued later for the same operationId (see issueOrGetReceipt).
 *   - Retries are idempotent: one receipt per operationId, stored in
 *     `audit_receipts` with a unique index, and concurrent issuers converge
 *     on the first stored receipt.
 *   - Receipts carry a hash of the target, not the target itself, so they can
 *     be shared without leaking ids of other users.
 */

import crypto from 'node:crypto';
import { AppError } from '../errors/AppError.js';
import { canonicalize } from '../backend/auditLedger.js';
import { hasPermission } from '../auth/permissions.js';

export const AUDIT_RECEIPT_VERSION = 'audit-receipt.v1';
export const AUDIT_RECEIPT_ALGORITHM = 'HMAC-SHA256';
export const AUDIT_RECEIPTS_COLLECTION = 'audit_receipts';
export const MIN_KEY_BYTES = 32;

/**
 * Action name prefixes that count as privileged. These match the action
 * names the admin routes already write to the audit ledger.
 */
export const PRIVILEGED_ACTION_PREFIXES = Object.freeze([
  'user.role_changed',
  'user.suspend',
  'user.reactivate',
  'moderation.',
  'quota.',
  'verification.',
  'material.catalog_access_',
  'impersonation.',
  'refund.',
  'payout.',
  'config.',
]);

export function isPrivilegedAction(action) {
  return typeof action === 'string' && PRIVILEGED_ACTION_PREFIXES.some((prefix) => action.startsWith(prefix));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Parses the receipt keyring from the environment.
 * Throws VALIDATION_FAILED for malformed or weak keys so bad config is caught
 * at the first use, not silently accepted.
 *
 * @returns {{ activeKeyId: string|null, keys: Map<string, Buffer>, revoked: Set<string> }}
 */
export function loadReceiptKeyring(env = process.env) {
  const keys = new Map();
  for (const entry of String(env.AUDIT_RECEIPT_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const sep = entry.indexOf(':');
    const kid = sep > 0 ? entry.slice(0, sep).trim() : '';
    const secret = sep > 0 ? Buffer.from(entry.slice(sep + 1).trim(), 'base64') : Buffer.alloc(0);
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(kid)) {
      throw new AppError('VALIDATION_FAILED', { message: 'AUDIT_RECEIPT_KEYS has an entry without a valid key id.', details: { reason: 'invalid_key_id' } });
    }
    if (secret.length < MIN_KEY_BYTES) {
      throw new AppError('VALIDATION_FAILED', {
        message: `Audit receipt key "${kid}" must decode to at least ${MIN_KEY_BYTES} bytes.`,
        details: { reason: 'weak_key', keyId: kid },
      });
    }
    keys.set(kid, secret);
  }
  const revoked = new Set(String(env.AUDIT_RECEIPT_REVOKED_KEY_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
  const activeKeyId = String(env.AUDIT_RECEIPT_ACTIVE_KEY_ID || '').trim() || null;
  return { activeKeyId, keys, revoked };
}

function sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(canonicalize(body)).digest('base64url');
}

function receiptBody(record, { keyId, issuedAt, actorRole }) {
  return {
    version: AUDIT_RECEIPT_VERSION,
    algorithm: AUDIT_RECEIPT_ALGORITHM,
    keyId,
    receiptId: sha256(`${record.operationId}:${record.recordHash}`).slice(0, 32),
    operationId: String(record.operationId),
    sequence: record.sequence,
    recordHash: record.recordHash,
    action: record.action,
    actor: record.actor,
    actorRole: actorRole || null,
    targetHash: sha256(canonicalize(record.target ?? null)),
    recordedAt: record.createdAt && !Number.isNaN(new Date(record.createdAt).getTime())
      ? new Date(record.createdAt).toISOString()
      : null,
    issuedAt: issuedAt.toISOString(),
  };
}

/**
 * Authorization for issuing or reading a receipt. Only privileged actions get
 * receipts, and only the acting operator or an admin may request one.
 * Returns true when the requester is the actor.
 */
export function assertCanRequestReceipt(record, requester) {
  if (!record || !record.operationId || !record.recordHash || !record.action) {
    throw new AppError('VALIDATION_FAILED', { message: 'A stored audit ledger record is required.', details: { reason: 'invalid_record' } });
  }
  if (!isPrivilegedAction(record.action)) {
    throw new AppError('VALIDATION_FAILED', {
      message: `Action "${record.action}" is not privileged; receipts are only issued for privileged actions.`,
      details: { reason: 'not_privileged' },
    });
  }
  const isActor = Boolean(requester?.id) && String(requester.id) === String(record.actor);
  if (!requester || !(isActor || hasPermission(requester, '*'))) {
    throw new AppError('AUTH_FORBIDDEN', {
      message: 'Only the acting operator or an admin can request this receipt.',
      details: { reason: 'receipt_forbidden' },
    });
  }
  return isActor;
}

/**
 * Signs a receipt for one audit ledger record.
 *
 * Authorization: see assertCanRequestReceipt.
 *
 * @param {object} options
 * @param {object} options.record      ledger record from appendAuditRecord
 * @param {object} options.requester   { id, role }
 * @param {object} [options.keyring]   from loadReceiptKeyring
 * @param {Date}   [options.now]
 */
export function issueAuditReceipt({ record, requester, keyring = loadReceiptKeyring(), now = new Date() }) {
  const isActor = assertCanRequestReceipt(record, requester);
  const keyId = keyring?.activeKeyId;
  const secret = keyId ? keyring.keys.get(keyId) : null;
  if (!secret || keyring.revoked.has(keyId)) {
    // Fail closed: never issue an unsigned or revoked-key receipt.
    throw new AppError('SERVICE_UNAVAILABLE', {
      message: 'Audit receipt signing key is not configured.',
      details: { reason: 'signing_key_unavailable' },
    });
  }
  const body = receiptBody(record, { keyId, issuedAt: now, actorRole: isActor ? requester.role : record.actorRole });
  return { ...body, signature: sign(body, secret) };
}

/**
 * Verifies a receipt. Never throws for bad input; returns a reason instead.
 *
 * @param {object} receipt
 * @param {object} [options]
 * @param {object} [options.keyring]
 * @param {object} [options.record]  when given, the receipt must match it
 * @returns {{ valid: boolean, reason: string|null }}
 */
export function verifyAuditReceipt(receipt, { keyring = loadReceiptKeyring(), record = null } = {}) {
  const fail = (reason) => ({ valid: false, reason });
  if (!receipt || typeof receipt !== 'object') return fail('malformed');
  if (receipt.version !== AUDIT_RECEIPT_VERSION) return fail('unsupported_version');
  if (receipt.algorithm !== AUDIT_RECEIPT_ALGORITHM) return fail('unsupported_algorithm');
  if (typeof receipt.signature !== 'string') return fail('malformed');
  if (keyring.revoked.has(receipt.keyId)) return fail('key_revoked');
  const secret = keyring.keys.get(receipt.keyId);
  if (!secret) return fail('unknown_key');

  const { signature, ...body } = receipt;
  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return fail('bad_signature');

  if (record) {
    if (String(record.operationId) !== receipt.operationId) return fail('record_mismatch');
    if (record.recordHash !== receipt.recordHash) return fail('record_mismatch');
    if (sha256(canonicalize(record.target ?? null)) !== receipt.targetHash) return fail('record_mismatch');
  }
  return { valid: true, reason: null };
}

/**
 * Idempotent issuance backed by the `audit_receipts` collection.
 * Looks up the ledger record by operationId, returns the stored receipt if
 * one exists, otherwise signs and stores one. Safe to retry and to call
 * concurrently: a duplicate-key race returns the receipt that won.
 */
export async function issueOrGetReceipt({ db, operationId, requester, keyring = loadReceiptKeyring(), now = new Date() }) {
  if (!operationId) {
    throw new AppError('VALIDATION_FAILED', { message: 'operationId is required.', details: { field: 'operationId' } });
  }
  const { COLLECTIONS } = await import('../backend/schemaContracts.js');
  const record = await db.collection(COLLECTIONS.auditLedger).findOne({ operationId: String(operationId) });
  if (!record) {
    throw new AppError('NOT_FOUND', { message: 'No audit record exists for this operation.', details: { reason: 'record_not_found' } });
  }

  const receipts = db.collection(AUDIT_RECEIPTS_COLLECTION);
  const strip = (doc) => {
    if (!doc) return doc;
    const { _id, ...rest } = doc;
    return rest;
  };

  const existing = await receipts.findOne({ operationId: String(operationId) });
  if (existing) {
    // Authorization still applies to re-reads.
    assertCanRequestReceipt(record, requester);
    return { receipt: strip(existing), created: false };
  }

  const receipt = issueAuditReceipt({ record, requester, keyring, now });
  try {
    await receipts.insertOne({ ...receipt });
    return { receipt, created: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const winner = await receipts.findOne({ operationId: String(operationId) });
    if (winner) return { receipt: strip(winner), created: false };
    throw new AppError('CONFLICT_STATE', { message: 'Receipt issuance raced and no receipt was stored.', details: { reason: 'receipt_race' } });
  }
}

/** Index needed for idempotent issuance. Run once per environment. */
export async function ensureAuditReceiptIndexes(db) {
  await db.collection(AUDIT_RECEIPTS_COLLECTION).createIndex({ operationId: 1 }, { unique: true, name: 'audit_receipts_operation_unique' });
}
