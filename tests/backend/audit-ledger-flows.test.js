import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { appendAuditRecord } from '../../src/lib/backend/auditLedger.js';

describe('Audit Ledger - Student Ownership, Marketplace, Storage Flows', () => {
  test('Actor attribution and event shape for marketplace purchase', async () => {
    let insertedRecord = null;
    const mockDb = {
      collection: () => ({
        insertOne: async (record) => {
          insertedRecord = record;
        }
      })
    };

    await appendAuditRecord({
      db: mockDb,
      operationId: 'commit:123',
      actor: 'buyer-address',
      action: 'purchase.committed',
      target: { type: 'material', id: 'mat-123' },
      result: { status: 'committed' }
    });

    assert.ok(insertedRecord);
    assert.equal(insertedRecord.actor, 'buyer-address');
    assert.equal(insertedRecord.action, 'purchase.committed');
    assert.equal(insertedRecord.target.type, 'material');
    assert.equal(insertedRecord.result.status, 'committed');
    assert.ok(insertedRecord.timestamp);
    assert.ok(insertedRecord.hash);
  });

  test('Actor attribution and event shape for storage GC', async () => {
    let insertedRecord = null;
    const mockDb = {
      collection: () => ({
        insertOne: async (record) => {
          insertedRecord = record;
        }
      })
    };

    await appendAuditRecord({
      db: mockDb,
      operationId: 'gc:unpin:cid123:999',
      actor: 'system',
      action: 'storage.gc.unpin',
      target: { type: 'storage_cid', id: 'cid123' },
      result: { status: 'unpinned', dryRun: false }
    });

    assert.ok(insertedRecord);
    assert.equal(insertedRecord.actor, 'system');
    assert.equal(insertedRecord.action, 'storage.gc.unpin');
    assert.equal(insertedRecord.target.id, 'cid123');
  });

  test('Actor attribution and event shape for student verification', async () => {
    let insertedRecord = null;
    const mockDb = {
      collection: () => ({
        insertOne: async (record) => {
          insertedRecord = record;
        }
      })
    };

    await appendAuditRecord({
      db: mockDb,
      operationId: 'student_verif:abc',
      actor: 'student-wallet',
      action: 'user.student_verification_submitted',
      target: { type: 'user', id: 'student-wallet' },
      result: { status: 'pending' }
    });

    assert.ok(insertedRecord);
    assert.equal(insertedRecord.actor, 'student-wallet');
    assert.equal(insertedRecord.action, 'user.student_verification_submitted');
    assert.equal(insertedRecord.target.id, 'student-wallet');
  });
});
