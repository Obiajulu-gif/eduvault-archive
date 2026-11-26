import assert from 'node:assert/strict';
import { describe, it, beforeAll, beforeEach } from 'node:test';
import { getDb } from '../../src/lib/mongodb.js';
import { REQUIRED_INDEXES } from '../../src/lib/backend/schemaContracts.js';
import { notify, retryFailedDelivery, DELIVERY_STATUSES } from '../../src/lib/notifications/notifications.js';

let db;
beforeAll(async () => {
  db = await getDb();
  for (const [name, indexes] of Object.entries(REQUIRED_INDEXES)) {
    if (!['notifications', 'notification_delivery_receipts'].includes(name)) continue;
    for (const { keys, options } of indexes) await db.collection(name).createIndex(keys, options).catch(() => {});
  }
});

beforeEach(async () => {
  await db.collection('notifications').deleteMany({});
  await db.collection('notification_delivery_receipts').deleteMany({});
});

describe('notification delivery receipts (#1105)', () => {
  it('persists a receipt for failed delivery attempts and does not duplicate on dedupe replay', async () => {
    const event = { recipient: 'u1', type: 'import_completed', dedupeKey: 'k1', title: 't', message: 'm', link: '/dashboard/my-materials' };
    const first = await notify(db, event);
    assert.equal(first.created, true);
    const second = await notify(db, event);
    assert.equal(second.created, false);

    const doc = await db.collection('notifications').findOne({ recipient: 'u1', dedupeKey: 'k1' });
    const result = await retryFailedDelivery(db, String(doc._id), async () => { throw new Error('smtp down'); }, { recipient: 'u1', maxAttempts: 3 });
    assert.equal(result.outcome, 'failed');
    assert.ok(result.receipt?.receiptId);

    const receipts = await db.collection('notification_delivery_receipts').find({ recipient: 'u1' }).toArray();
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, DELIVERY_STATUSES.failed);
    assert.equal(receipts[0].dedupeKey, 'k1');
  });

  it('records sent receipt and prevents double send', async () => {
    await notify(db, { recipient: 'u1', type: 'import_completed', dedupeKey: 'k2', title: 't', message: 'm' });
    const doc = await db.collection('notifications').findOne({ dedupeKey: 'k2' });
    const sent = await retryFailedDelivery(db, String(doc._id), async () => {}, { recipient: 'u1', maxAttempts: 3 });
    assert.equal(sent.outcome, 'sent');
    assert.ok(sent.receipt?.receiptId);

    const again = await retryFailedDelivery(db, String(doc._id), async () => { throw new Error('should not run'); }, { recipient: 'u1', maxAttempts: 3 });
    assert.equal(again.outcome, 'already_sent');
    assert.equal(again.doubleSendPrevented, true);

    const receipts = await db.collection('notification_delivery_receipts').find({ notificationId: String(doc._id) }).toArray();
    assert.equal(receipts.length, 1);
  });
});
