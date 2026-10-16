import { describe, expect, it } from 'vitest';
import { appendAuditRecord, appendCriticalMutation, verifyAuditRecords } from '../auditLedger';

function makeDb() {
  const records = [];
  const collection = {
    findOne: async (query) => records.find((record) => record.operationId === query.operationId) || null,
    find: () => ({
      sort: () => ({ limit: () => ({ toArray: async () => [...records].sort((a, b) => b.sequence - a.sequence).slice(0, 1) }) }),
    }),
    insertOne: async (record) => {
      if (records.some((item) => item.operationId === record.operationId || item.sequence === record.sequence)) {
        const error = new Error('duplicate');
        error.code = 11000;
        throw error;
      }
      records.push(record);
    },
    all: () => [...records].sort((a, b) => a.sequence - b.sequence),
  };
  return { collection: () => collection, collectionStore: collection };
}

describe('audit ledger', () => {
  it('is idempotent and detects edits, deletion, and reordering', async () => {
    const db = makeDb();
    await appendAuditRecord({ db, operationId: 'op-1', actor: 'admin-1', action: 'user.suspend', target: { type: 'user', id: 'u-1' }, result: { status: 'suspended' } });
    const duplicate = await appendAuditRecord({ db, operationId: 'op-1', actor: 'admin-1', action: 'user.suspend', target: { type: 'user', id: 'u-1' }, result: { status: 'suspended' } });
    expect(db.collectionStore.all()).toHaveLength(1);
    expect(duplicate.operationId).toBe('op-1');

    await appendAuditRecord({ db, operationId: 'op-2', actor: 'admin-1', action: 'refund.approved', target: { type: 'refund', id: 'r-1' }, result: { status: 'approved' } });
    expect(verifyAuditRecords(db.collectionStore.all()).valid).toBe(true);

    const edited = db.collectionStore.all();
    edited[0].result.status = 'active';
    expect(verifyAuditRecords(edited).valid).toBe(false);
    expect(verifyAuditRecords(db.collectionStore.all().reverse()).valid).toBe(false);
    expect(verifyAuditRecords(db.collectionStore.all().slice(1)).valid).toBe(false);
  });

  it('records before/after metadata and rejects a no-op critical update', async () => {
    const db = makeDb();
    await appendCriticalMutation({
      db,
      operationId: 'material.update:m-1:2',
      actor: 'creator-1',
      action: 'material.access_terms_updated',
      target: { type: 'material', id: 'm-1' },
      reason: 'Corrected the price',
      before: { price: 12, visibility: 'public' },
      after: { price: 15, visibility: 'public' },
      intent: { source: 'creator' },
    });

    const [record] = db.collectionStore.all();
    expect(record.before).toEqual({ price: 12, visibility: 'public' });
    expect(record.after).toEqual({ price: 15, visibility: 'public' });
    expect(verifyAuditRecords([record])).toMatchObject({ valid: true, records: 1 });

    await expect(appendCriticalMutation({
      db,
      operationId: 'material.update:m-1:3',
      actor: 'creator-1',
      action: 'material.access_terms_updated',
      target: { type: 'material', id: 'm-1' },
      reason: 'No change',
      before: { price: 15 },
      after: { price: 15 },
    })).rejects.toThrow('must change');
    expect(db.collectionStore.all()).toHaveLength(1);
  });
});
