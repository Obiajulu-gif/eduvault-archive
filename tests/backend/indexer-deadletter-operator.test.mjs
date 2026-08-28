import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  listDeadLetterEvents,
  quarantineDeadLetter,
  retryDeadLetter,
  classifyIndexerError,
} from '../../src/lib/indexer/stellarIndexer.js';
import { COLLECTIONS } from '../../src/lib/backend/schemaContracts.js';

function createDeadLetterDb(initial = []) {
  const deadLetters = new Map(initial.map((entry) => [entry._id, { ...entry }]));
  const audit = [];

  return {
    db: {
      collection(name) {
        if (name === COLLECTIONS.deadLetterEvents) {
          return {
            records: deadLetters,
            async findOne(query) {
              return deadLetters.get(query._id) || null;
            },
            async find(query = {}) {
              const values = Array.from(deadLetters.values()).filter((entry) =>
                query.status ? entry.status === query.status : true
              );
              return {
                sort() {
                  return this;
                },
                limit(limit) {
                  return Promise.resolve(values.slice(0, limit));
                },
                toArray: async () => values,
              };
            },
            async updateOne(query, update) {
              const current = deadLetters.get(query._id);
              if (!current) return;
              deadLetters.set(query._id, { ...current, ...(update.$set || {}) });
            },
            async deleteOne(query) {
              deadLetters.delete(query._id);
            },
          };
        }

        if (name === COLLECTIONS.indexerOperatorAudit) {
          return {
            async insertOne(doc) {
              audit.push(doc);
            },
          };
        }

        if (name === COLLECTIONS.syncEvents) {
          return {
            async insertOne() {},
          };
        }

        if (name === COLLECTIONS.purchases) {
          return {
            async updateOne() {},
          };
        }

        if (name === COLLECTIONS.entitlementCache) {
          return {
            async updateOne() {},
          };
        }

        return {
          async insertOne() {},
          async updateOne() {},
          async deleteOne() {},
          async findOne() {
            return null;
          },
        };
      },
    },
    deadLetters,
    audit,
  };
}

test('listDeadLetterEvents returns retryable and failed entries', async () => {
  const { db } = createDeadLetterDb([
    { _id: 'evt-1', status: 'retryable', errorClass: 'transient' },
    { _id: 'evt-2', status: 'failed', errorClass: 'poison' },
  ]);

  const all = await listDeadLetterEvents(db);
  assert.equal(all.length, 2);
  const retryable = await listDeadLetterEvents(db, { status: 'retryable' });
  assert.equal(retryable.length, 1);
});

test('quarantineDeadLetter requires explicit reason and writes audit log', async () => {
  const { db, deadLetters, audit } = createDeadLetterDb([
    {
      _id: 'evt-poison',
      status: 'failed',
      errorClass: 'poison',
      parsed: { type: 'material.registered', materialId: 'mat-1' },
    },
  ]);

  await assert.rejects(
    () => quarantineDeadLetter(db, 'evt-poison', { reason: '   ' }),
    /explicit quarantine reason/
  );

  await quarantineDeadLetter(db, 'evt-poison', {
    reason: 'Malformed event payload',
    operator: 'ops-user',
  });

  assert.equal(deadLetters.get('evt-poison').status, 'quarantined');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'quarantine');
});

test('retryDeadLetter rejects quarantined events and audits successful retries', async () => {
  const { db, audit } = createDeadLetterDb([
    {
      _id: 'evt-retry',
      status: 'retryable',
      parsed: {
        type: 'purchase.completed',
        materialId: 'mat-1',
        buyerAddress: 'gbuyer',
        purchaseId: 1,
      },
    },
    {
      _id: 'evt-quarantined',
      status: 'quarantined',
      parsed: { type: 'material.registered', materialId: 'mat-2' },
    },
  ]);

  await assert.rejects(
    () => retryDeadLetter(db, 'evt-quarantined'),
    /Quarantined events/
  );

  const result = await retryDeadLetter(db, 'evt-retry', { operator: 'ops-user' });
  assert.equal(result.retried, true);
  assert.equal(audit.at(-1).action, 'retry');
});

test('duplicate event handling remains idempotent during operator retry', async () => {
  const { db } = createDeadLetterDb([
    {
      _id: 'evt-dup',
      status: 'retryable',
      parsed: {
        type: 'purchase.completed',
        materialId: 'mat-dup',
        buyerAddress: 'gbuyer',
        purchaseId: 99,
      },
    },
  ]);

  await retryDeadLetter(db, 'evt-dup');
  await assert.rejects(() => retryDeadLetter(db, 'evt-dup'), /not found/);
});

test('classifyIndexerError still distinguishes transient and poison failures', () => {
  assert.equal(classifyIndexerError({ code: 'ETIMEDOUT' }), 'transient');
  assert.equal(classifyIndexerError({ message: 'invalid payload' }), 'poison');
});
