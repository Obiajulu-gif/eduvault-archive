/**
 * User-visible operation history with filtered sensitive details (#882).
 *
 * The ledger is seeded through the real `appendAuditRecord`, with the same
 * actor/target shapes the production writers use (purchase access, refund
 * workflow, admin role/suspend routes, identity links).
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { appendAuditRecord } from '../../src/lib/backend/auditLedger.js';
import { REQUIRED_INDEXES } from '../../src/lib/backend/schemaContracts.js';
import {
  HISTORY_MAX_LIMIT,
  OPERATION_HISTORY_EVENTS,
  getOperationHistory,
  parseHistoryQuery,
} from '../../src/lib/operations/operationHistory.js';

const ALICE_WALLET = 'GALICE7Q2QXDWUC7Z2V6XPW2MQXQ7CQ4M5U7EJZ2W3V5Y6Z7A2B3C4D5';
const BOB_WALLET = 'GBOB2QXDWUC7Z2V6XPW2MQXQ7CQ4M5U7EJZ2W3V5Y6Z7A2B3C4D5E6F';
const ADMIN_ID = '65aa00000000000000000099';

let mongod;
let client;
let db;
let alice;
let bob;
let seq;
let materialLive;
let materialRetired;
let materialGone;
let aliceRefund;

async function record(action, actor, target, result = {}, extra = {}) {
  seq += 1;
  return appendAuditRecord({ db, operationId: `test:${seq}`, actor, action, target, result, ...extra });
}

async function allPages(user, query = {}) {
  const events = [];
  let cursor;
  for (;;) {
    const page = await getOperationHistory({ db, user, query: { ...query, cursor } });
    events.push(...page.events);
    if (!page.hasMore) return events;
    cursor = page.nextCursor;
  }
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('operation_history_test');
});

after(async () => {
  await client.close();
  await mongod.stop();
});

beforeEach(async () => {
  await db.dropDatabase();
  for (const { keys, options } of REQUIRED_INDEXES.audit_ledger) await db.collection('audit_ledger').createIndex(keys, options);
  seq = 0;

  alice = { _id: new ObjectId(), walletAddress: ALICE_WALLET };
  bob = { _id: new ObjectId(), walletAddress: BOB_WALLET };
  [materialLive, materialRetired, materialGone] = [new ObjectId(), new ObjectId(), new ObjectId()];
  await db.collection('materials').insertMany([
    { _id: materialLive, title: 'Linear Algebra Notes' },
    { _id: materialRetired, title: 'Retired Notes', isDeleted: true },
  ]);
  aliceRefund = new ObjectId();
  await db.collection('refunds').insertMany([
    { _id: aliceRefund, buyerAddress: ALICE_WALLET },
    { _id: new ObjectId(), buyerAddress: BOB_WALLET },
  ]);

  // Alice: purchases (actor), refund lifecycle (owner), admin actions (subject), identity (subject).
  await record('purchase.reserved', ALICE_WALLET, { type: 'material', id: String(materialLive) }, { status: 'reserved' });
  await record('purchase.committed', ALICE_WALLET, { type: 'material', id: String(materialLive) }, { status: 'committed', purchaseId: 'p-1' });
  await record('purchase.committed', ALICE_WALLET, { type: 'material', id: String(materialRetired) }, { status: 'committed', purchaseId: 'p-2' });
  await record('purchase.committed', ALICE_WALLET, { type: 'material', id: String(materialGone) }, { status: 'committed', purchaseId: 'p-3' });
  await record('refund.requested', ALICE_WALLET, { type: 'refund', id: String(aliceRefund) }, { status: 'requested', correlationId: 'corr-internal' }, { reason: 'did not like it' });
  await record('refund.approved', ADMIN_ID, { type: 'refund', id: String(aliceRefund) }, { status: 'approved', correlationId: 'corr-internal' }, { reason: 'internal note: goodwill' });
  await record('refund.submitting', 'system', { type: 'refund', id: String(aliceRefund) }, { status: 'submitting' });
  await record(
    'user.role_changed',
    ADMIN_ID,
    { type: 'user', id: String(alice._id) },
    { previousRole: 'learner', newRole: 'creator', diffReport: { added: ['materials:write'] } },
    { reason: 'escalation ticket 42' }
  );
  await record('identity.linked', String(alice._id), { type: 'user', id: String(alice._id) }, { status: 'linked', provider: 'stellar', linkId: 'l-1' });
  await record('identity.unlink_denied', String(bob._id), { type: 'identity_link', id: 'l-1' }, { status: 'denied' });

  // Internal / other users' operations that must never reach Alice.
  await record('purchase.committed', BOB_WALLET, { type: 'material', id: String(materialLive) }, { status: 'committed', purchaseId: 'p-bob' });
  await record('moderation.takedown', ADMIN_ID, { type: 'moderation_case', id: 'case-1' }, { success: true });
  await record('purchase.expired', 'system', { type: 'material', id: String(materialLive) }, { status: 'expired' });
});

describe('visibility', () => {
  it("returns only the caller's own operations, newest first", async () => {
    const events = await allPages(alice);
    assert.deepEqual(events.map((e) => e.type), [
      'identity.linked',
      'account.role_changed',
      'refund.approved',
      'refund.requested',
      'purchase.completed',
      'purchase.completed',
      'purchase.completed',
      'purchase.started',
    ]);
  });

  it("never shows another user's operations", async () => {
    const events = await allPages(bob);
    assert.deepEqual(events.map((e) => [e.type, e.details.purchaseId]), [['purchase.completed', 'p-bob']]);
  });

  it('matches wallet identities regardless of stored casing', async () => {
    await record('user.student_verification_submitted', ALICE_WALLET.toLowerCase(), { type: 'user', id: ALICE_WALLET.toLowerCase() }, { status: 'pending', verificationId: 'v-1' });
    const [latest] = (await getOperationHistory({ db, user: alice })).events;
    assert.equal(latest.type, 'verification.submitted');
    assert.deepEqual(latest.details, { status: 'pending' });
  });

  it('hides internal-only actions', async () => {
    const shown = new Set((await allPages(alice)).map((e) => e.type));
    assert.equal(shown.has('refund.submitting'), false);
    assert.ok(!('refund.submitting' in OPERATION_HISTORY_EVENTS));
    assert.ok(!('identity.unlink_denied' in OPERATION_HISTORY_EVENTS));
  });
});

describe('redaction', () => {
  it('exposes only allow-listed details and never maintainer identity or internal metadata', async () => {
    const events = await allPages(alice);
    const serialized = JSON.stringify(events);

    for (const secret of [ADMIN_ID, 'internal note', 'escalation ticket', 'corr-internal', 'materials:write', 'did not like it']) {
      assert.ok(!serialized.includes(secret), `leaked ${secret}`);
    }
    for (const field of ['actor', 'actorProof', 'intentHash', 'recordHash', 'previousHash', 'operationId', 'sequence', 'before', 'after', 'reason']) {
      assert.ok(events.every((e) => !(field in e)), `exposed ${field}`);
    }

    const roleChange = events.find((e) => e.type === 'account.role_changed');
    assert.deepEqual(roleChange.details, { newRole: 'creator' });
    assert.equal(roleChange.performedBy, 'eduvault');
    assert.equal(events.find((e) => e.type === 'refund.approved').performedBy, 'eduvault');
    assert.equal(events.find((e) => e.type === 'refund.requested').performedBy, 'you');
  });
});

describe('deleted records', () => {
  it('keeps the event but withholds details of retired or removed materials', async () => {
    const completed = (await allPages(alice, { type: 'purchase.completed' })).reverse();
    assert.deepEqual(
      completed.map((e) => e.resource),
      [
        { type: 'material', id: String(materialLive), title: 'Linear Algebra Notes', available: true },
        { type: 'material', id: String(materialRetired), available: false },
        { type: 'material', id: String(materialGone), available: false },
      ]
    );
  });
});

describe('pagination', () => {
  it('walks every page exactly once', async () => {
    const all = await allPages(alice);
    const paged = await allPages(alice, { limit: 3 });
    assert.deepEqual(paged.map((e) => e.id), all.map((e) => e.id));
    assert.equal(new Set(paged.map((e) => e.id)).size, paged.length);
  });

  it('stays stable when new operations are appended between pages', async () => {
    const first = await getOperationHistory({ db, user: alice, query: { limit: 3 } });
    await record('purchase.reserved', ALICE_WALLET, { type: 'material', id: String(materialLive) }, { status: 'reserved' });

    const rest = [];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await getOperationHistory({ db, user: alice, query: { limit: 3, cursor } });
      rest.push(...page.events);
      cursor = page.nextCursor;
    }
    const ids = [...first.events, ...rest].map((e) => e.id);
    assert.equal(ids.length, 8, 'the appended operation belongs to a fresh first page, not a later one');
    assert.equal(new Set(ids).size, ids.length);
  });

  it('caps the page size and rejects tampered or mismatched cursors', async () => {
    assert.equal(parseHistoryQuery({ limit: '5000' }).limit, HISTORY_MAX_LIMIT);
    const { nextCursor } = await getOperationHistory({ db, user: alice, query: { limit: 1 } });
    await assert.rejects(getOperationHistory({ db, user: alice, query: { limit: 1, cursor: 'garbage' } }), { code: 'INVALID_HISTORY_QUERY' });
    await assert.rejects(getOperationHistory({ db, user: alice, query: { category: 'refund', cursor: nextCursor } }), {
      code: 'INVALID_HISTORY_QUERY',
    });
  });
});

describe('filtering', () => {
  it('filters by category and type', async () => {
    assert.deepEqual((await allPages(alice, { category: 'refund' })).map((e) => e.type), ['refund.approved', 'refund.requested']);
    assert.deepEqual((await allPages(alice, { category: 'identity' })).map((e) => e.type), ['identity.linked']);
    assert.equal((await allPages(alice, { type: 'purchase.started' })).length, 1);
    assert.deepEqual(await allPages(alice, { category: 'content' }), []);
  });

  it('filters by date range', async () => {
    await db.collection('audit_ledger').updateMany({}, { $set: { createdAt: new Date('2026-01-01T00:00:00Z') } });
    await db.collection('audit_ledger').updateOne({ action: 'identity.linked' }, { $set: { createdAt: new Date('2026-06-01T00:00:00Z') } });

    assert.deepEqual((await allPages(alice, { from: '2026-05-01T00:00:00Z' })).map((e) => e.type), ['identity.linked']);
    assert.equal((await allPages(alice, { to: '2026-02-01T00:00:00Z' })).length, 7);
  });

  it('rejects invalid query parameters', async () => {
    for (const query of [{ category: 'secrets' }, { type: 'refund.submitting' }, { from: 'yesterday' }, { limit: '0' }, { from: '2026-02-01', to: '2026-01-01' }]) {
      await assert.rejects(getOperationHistory({ db, user: alice, query }), { code: 'INVALID_HISTORY_QUERY' }, JSON.stringify(query));
    }
  });
});

describe('unauthorized access', () => {
  it('refuses callers without an identity', async () => {
    await assert.rejects(getOperationHistory({ db, user: null }), { code: 'AUTH_REQUIRED', status: 401 });
    await assert.rejects(getOperationHistory({ db, user: {} }), { code: 'AUTH_REQUIRED', status: 401 });
  });

  it('cannot reach other users through a cursor', async () => {
    // Make Alice's newest operation later than Bob's so her cursor spans his rows.
    await record('purchase.committed', ALICE_WALLET, { type: 'material', id: String(materialLive) }, { status: 'committed', purchaseId: 'p-4' });
    const { nextCursor } = await getOperationHistory({ db, user: alice, query: { limit: 1 } });

    const page = await getOperationHistory({ db, user: bob, query: { limit: 1, cursor: nextCursor } });
    assert.deepEqual(page.events.map((e) => e.details.purchaseId), ['p-bob']);
  });
});
