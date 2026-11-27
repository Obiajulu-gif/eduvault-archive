/**
 * Signed audit receipts for privileged actions (#1082).
 * Covers the normal, failure, retry, and authorization paths.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { appendAuditRecord } from '../../src/lib/backend/auditLedger.js';
import {
  AUDIT_RECEIPTS_COLLECTION,
  ensureAuditReceiptIndexes,
  isPrivilegedAction,
  issueAuditReceipt,
  issueOrGetReceipt,
  loadReceiptKeyring,
  verifyAuditReceipt,
} from '../../src/lib/audit/auditReceipts.js';

const NOW = new Date('2026-11-18T12:00:00Z');
const key = (fill) => Buffer.alloc(32, fill).toString('base64');
const ENV = { AUDIT_RECEIPT_KEYS: `k1:${key(1)},k2:${key(2)}`, AUDIT_RECEIPT_ACTIVE_KEY_ID: 'k2' };
const ADMIN = { id: 'admin-1', role: 'admin' };

/** Minimal in-memory Mongo double with the calls the ledger and receipts use. */
function fakeDb() {
  const collections = new Map();
  const matches = (doc, query) => Object.entries(query).every(([k, v]) => doc[k] === v);
  const get = (name) => {
    if (!collections.has(name)) {
      const docs = [];
      const unique = new Set();
      collections.set(name, {
        docs,
        unique,
        failNextInsertWithDuplicate: null,
        async findOne(query) { return docs.find((d) => matches(d, query)) || null; },
        find(query) {
          let result = docs.filter((d) => matches(d, query));
          const cursor = {
            sort(spec) { const [[field, dir]] = Object.entries(spec); result = [...result].sort((a, b) => (a[field] - b[field]) * dir); return cursor; },
            limit(n) { result = result.slice(0, n); return cursor; },
            async toArray() { return result; },
          };
          return cursor;
        },
        async insertOne(doc) {
          const c = collections.get(name);
          if (c.failNextInsertWithDuplicate) {
            const winner = c.failNextInsertWithDuplicate;
            c.failNextInsertWithDuplicate = null;
            docs.push(winner);
            throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
          }
          if (unique.has('operationId') && docs.some((d) => d.operationId === doc.operationId)) {
            throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
          }
          docs.push({ _id: `id-${docs.length}`, ...doc });
          return { acknowledged: true };
        },
        async createIndex(spec, opts) { if (opts?.unique) for (const k of Object.keys(spec)) unique.add(k); },
      });
    }
    return collections.get(name);
  };
  return { collection: get };
}

async function privilegedRecord(db, overrides = {}) {
  return appendAuditRecord({
    db,
    operationId: 'op-role-1',
    actor: 'admin-1',
    action: 'user.role_changed',
    target: { userId: 'learner-42' },
    result: { ok: true },
    before: { role: 'learner' },
    after: { role: 'creator' },
    ...overrides,
  });
}

describe('normal path', () => {
  test('issues a receipt that verifies and pins the ledger record', async () => {
    const db = fakeDb();
    const record = await privilegedRecord(db);
    const keyring = loadReceiptKeyring(ENV);
    const receipt = issueAuditReceipt({ record, requester: ADMIN, keyring, now: NOW });

    assert.equal(receipt.keyId, 'k2');
    assert.equal(receipt.recordHash, record.recordHash);
    assert.equal(receipt.issuedAt, NOW.toISOString());
    assert.ok(!JSON.stringify(receipt).includes('learner-42'), 'target is hashed, not embedded');
    assert.deepEqual(verifyAuditReceipt(receipt, { keyring, record }), { valid: true, reason: null });
  });

  test('privileged action detection matches admin route action names', () => {
    for (const action of ['user.role_changed', 'user.suspend', 'moderation.approve', 'quota.override', 'verification.approve', 'material.catalog_access_revoked']) {
      assert.equal(isPrivilegedAction(action), true, action);
    }
    for (const action of ['scan', 'user.student_verification_submitted', 'material.access_terms_updated', undefined]) {
      assert.equal(isPrivilegedAction(action), false, String(action));
    }
  });

  test('receipts signed with a rotated-out active key still verify', async () => {
    const record = await privilegedRecord(fakeDb());
    const old = issueAuditReceipt({ record, requester: ADMIN, keyring: loadReceiptKeyring({ ...ENV, AUDIT_RECEIPT_ACTIVE_KEY_ID: 'k1' }), now: NOW });
    const rotated = loadReceiptKeyring({ ...ENV, AUDIT_RECEIPT_ACTIVE_KEY_ID: 'k2' });
    assert.equal(verifyAuditReceipt(old, { keyring: rotated }).valid, true);
  });
});

describe('failure paths', () => {
  test('tampering with any field or the signature is detected', async () => {
    const keyring = loadReceiptKeyring(ENV);
    const receipt = issueAuditReceipt({ record: await privilegedRecord(fakeDb()), requester: ADMIN, keyring, now: NOW });
    assert.equal(verifyAuditReceipt({ ...receipt, actor: 'someone-else' }, { keyring }).reason, 'bad_signature');
    assert.equal(verifyAuditReceipt({ ...receipt, signature: receipt.signature.slice(0, -2) + 'AA' }, { keyring }).reason, 'bad_signature');
    assert.equal(verifyAuditReceipt({ ...receipt, signature: 'short' }, { keyring }).reason, 'bad_signature');
    assert.equal(verifyAuditReceipt({ ...receipt, version: 'v0' }, { keyring }).reason, 'unsupported_version');
    assert.equal(verifyAuditReceipt({ ...receipt, algorithm: 'none' }, { keyring }).reason, 'unsupported_algorithm');
    assert.equal(verifyAuditReceipt(null, { keyring }).reason, 'malformed');
  });

  test('a rewritten ledger record no longer matches its receipt', async () => {
    const keyring = loadReceiptKeyring(ENV);
    const record = await privilegedRecord(fakeDb());
    const receipt = issueAuditReceipt({ record, requester: ADMIN, keyring, now: NOW });
    assert.equal(verifyAuditReceipt(receipt, { keyring, record: { ...record, recordHash: 'f'.repeat(64) } }).reason, 'record_mismatch');
    assert.equal(verifyAuditReceipt(receipt, { keyring, record: { ...record, target: { userId: 'other' } } }).reason, 'record_mismatch');
  });

  test('unknown and revoked keys fail verification', async () => {
    const receipt = issueAuditReceipt({ record: await privilegedRecord(fakeDb()), requester: ADMIN, keyring: loadReceiptKeyring(ENV), now: NOW });
    assert.equal(verifyAuditReceipt(receipt, { keyring: loadReceiptKeyring({ AUDIT_RECEIPT_KEYS: `k1:${key(1)}` }) }).reason, 'unknown_key');
    assert.equal(verifyAuditReceipt(receipt, { keyring: loadReceiptKeyring({ ...ENV, AUDIT_RECEIPT_REVOKED_KEY_IDS: 'k2' }) }).reason, 'key_revoked');
  });

  test('issuing fails closed without a usable signing key', async () => {
    const record = await privilegedRecord(fakeDb());
    for (const env of [{}, { AUDIT_RECEIPT_KEYS: `k1:${key(1)}` }, { ...ENV, AUDIT_RECEIPT_REVOKED_KEY_IDS: 'k2' }]) {
      assert.throws(
        () => issueAuditReceipt({ record, requester: ADMIN, keyring: loadReceiptKeyring(env), now: NOW }),
        (error) => error.code === 'SERVICE_UNAVAILABLE' && error.details.reason === 'signing_key_unavailable'
      );
    }
  });

  test('weak or malformed keys are rejected at load time', () => {
    assert.throws(() => loadReceiptKeyring({ AUDIT_RECEIPT_KEYS: `k1:${Buffer.alloc(8).toString('base64')}` }), (e) => e.details.reason === 'weak_key');
    assert.throws(() => loadReceiptKeyring({ AUDIT_RECEIPT_KEYS: `:${key(1)}` }), (e) => e.details.reason === 'invalid_key_id');
    assert.equal(loadReceiptKeyring({}).keys.size, 0);
  });

  test('non-privileged actions and invalid records are refused', async () => {
    const keyring = loadReceiptKeyring(ENV);
    const record = await privilegedRecord(fakeDb(), { action: 'material.access_terms_updated' });
    assert.throws(() => issueAuditReceipt({ record, requester: ADMIN, keyring }), (e) => e.details.reason === 'not_privileged');
    assert.throws(() => issueAuditReceipt({ record: {}, requester: ADMIN, keyring }), (e) => e.details.reason === 'invalid_record');
  });
});

describe('authorization path', () => {
  test('the acting operator and admins may request; others may not', async () => {
    const keyring = loadReceiptKeyring(ENV);
    const record = await privilegedRecord(fakeDb(), { actor: 'moderator-7', action: 'moderation.approve' });

    const own = issueAuditReceipt({ record, requester: { id: 'moderator-7', role: 'creator' }, keyring, now: NOW });
    assert.equal(own.actorRole, 'creator');
    assert.ok(issueAuditReceipt({ record, requester: ADMIN, keyring, now: NOW }));

    for (const requester of [null, { id: 'learner-42', role: 'learner' }, { id: 'svc', role: 'service' }, { role: 'creator' }]) {
      assert.throws(
        () => issueAuditReceipt({ record, requester, keyring, now: NOW }),
        (error) => error.code === 'AUTH_FORBIDDEN',
        JSON.stringify(requester)
      );
    }
  });

  test('re-reading a stored receipt still enforces authorization', async () => {
    const db = fakeDb();
    await privilegedRecord(db);
    const keyring = loadReceiptKeyring(ENV);
    await issueOrGetReceipt({ db, operationId: 'op-role-1', requester: ADMIN, keyring, now: NOW });
    await assert.rejects(
      issueOrGetReceipt({ db, operationId: 'op-role-1', requester: { id: 'learner-42', role: 'learner' }, keyring }),
      (error) => error.code === 'AUTH_FORBIDDEN'
    );
  });
});

describe('retry path (issueOrGetReceipt)', () => {
  test('retries return the same stored receipt instead of signing a new one', async () => {
    const db = fakeDb();
    await ensureAuditReceiptIndexes(db);
    await privilegedRecord(db);
    const keyring = loadReceiptKeyring(ENV);

    const first = await issueOrGetReceipt({ db, operationId: 'op-role-1', requester: ADMIN, keyring, now: NOW });
    const later = new Date(NOW.getTime() + 60_000);
    const second = await issueOrGetReceipt({ db, operationId: 'op-role-1', requester: ADMIN, keyring, now: later });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.deepEqual(second.receipt, first.receipt);
    assert.equal(db.collection(AUDIT_RECEIPTS_COLLECTION).docs.length, 1);
  });

  test('a stored receipt is still returned after its key is rotated out of active use', async () => {
    const db = fakeDb();
    await privilegedRecord(db);
    await issueOrGetReceipt({ db, operationId: 'op-role-1', requester: ADMIN, keyring: loadReceiptKeyring({ ...ENV, AUDIT_RECEIPT_ACTIVE_KEY_ID: 'k1' }), now: NOW });
    const again = await issueOrGetReceipt({ db, operationId: 'op-role-1', requester: ADMIN, keyring: loadReceiptKeyring(ENV) });
    assert.equal(again.receipt.keyId, 'k1');
    assert.equal(verifyAuditReceipt(again.receipt, { keyring: loadReceiptKeyring(ENV) }).valid, true);
  });

  test('a concurrent issuer that loses the race returns the winning receipt', async () => {
    const db = fakeDb();
    await privilegedRecord(db);
    const keyring = loadReceiptKeyring(ENV);
    const winner = { ...issueAuditReceipt({ record: await db.collection('audit_ledger').findOne({ operationId: 'op-role-1' }), requester: ADMIN, keyring, now: NOW }), _id: 'w' };
    db.collection(AUDIT_RECEIPTS_COLLECTION).failNextInsertWithDuplicate = winner;

    const result = await issueOrGetReceipt({ db, operationId: 'op-role-1', requester: ADMIN, keyring, now: new Date(NOW.getTime() + 5) });
    assert.equal(result.created, false);
    assert.equal(result.receipt._id, undefined);
    assert.equal(result.receipt.signature, winner.signature);
  });

  test('a missing ledger record or operationId is reported, not signed', async () => {
    const keyring = loadReceiptKeyring(ENV);
    await assert.rejects(issueOrGetReceipt({ db: fakeDb(), operationId: 'nope', requester: ADMIN, keyring }), (e) => e.code === 'NOT_FOUND');
    await assert.rejects(issueOrGetReceipt({ db: fakeDb(), operationId: '', requester: ADMIN, keyring }), (e) => e.code === 'VALIDATION_FAILED');
  });
});
