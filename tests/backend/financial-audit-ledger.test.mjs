import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  appendFinancialEvent,
  appendPrivilegedEvent,
  verifyLedgerIntegrity,
  exportLedger,
  EVENT_DOMAINS,
  FINANCIAL_EVENT_TYPES,
  PRIVILEGED_EVENT_TYPES,
  GENESIS_HASH,
} from '../../src/lib/backend/financialAuditLedger.js';

function createMockLedgerDb(initialRecords = []) {
  const records = [...initialRecords];
  return {
    _records: records,
    collection(name) {
      return {
        async findOne(query) {
          return records.find((r) => Object.entries(query).every(([k, v]) => r[k] === v)) || null;
        },
        find(query = {}) {
          const filtered = records.filter((r) => {
            for (const [k, v] of Object.entries(query)) {
              if (v && typeof v === 'object' && '$gte' in v) {
                if (!(new Date(r[k]) >= new Date(v.$gte))) return false;
                continue;
              }
              if (v && typeof v === 'object' && '$lte' in v) {
                if (!(new Date(r[k]) <= new Date(v.$lte))) return false;
                continue;
              }
              if (r[k] !== v) return false;
            }
            return true;
          });

          let resultList = filtered;
          const cursor = {
            sort(sortCriteria) {
              const sortKey = Object.keys(sortCriteria)[0];
              const sortDir = sortCriteria[sortKey];
              resultList.sort((a, b) => {
                const valA = a[sortKey] || 0;
                const valB = b[sortKey] || 0;
                return sortDir === -1 ? (valB > valA ? 1 : -1) : (valA > valB ? 1 : -1);
              });
              return cursor;
            },
            limit(count) {
              resultList = resultList.slice(0, count);
              return cursor;
            },
            toArray: async () => [...resultList],
          };
          return cursor;
        },
        async insertOne(doc) {
          if (records.some((r) => r.sequence === doc.sequence)) {
            const err = new Error('E11000 duplicate key error');
            err.code = 11000;
            throw err;
          }
          records.push({ ...doc, _id: `id-${doc.sequence}` });
          return { acknowledged: true, insertedId: `id-${doc.sequence}` };
        },
      };
    },
  };
}

describe('Tamper-Evident Chronological Ledger (#958)', () => {
  test('creates valid hash-chained financial and privileged events starting from genesis', async () => {
    const mockDb = createMockLedgerDb();
    const t0 = new Date('2026-10-15T12:00:00Z');
    const t1 = new Date('2026-10-15T12:01:00Z');
    const t2 = new Date('2026-10-15T12:02:00Z');

    const ev1 = await appendFinancialEvent(mockDb, {
      operationId: 'payout-101',
      eventType: FINANCIAL_EVENT_TYPES.PAYOUT_SETTLED,
      actor: 'system-treasury',
      financialDetails: { amount: 1500, asset: 'XLM', recipient: 'GCREATOR' },
      target: { type: 'payout', id: 'pay-101' },
      timestamp: t0,
    });

    assert.equal(ev1.sequence, 0);
    assert.equal(ev1.previousHash, GENESIS_HASH);
    assert.equal(ev1.eventDomain, EVENT_DOMAINS.FINANCIAL);
    assert.ok(ev1.recordHash);

    const ev2 = await appendPrivilegedEvent(mockDb, {
      operationId: 'admin-mod-202',
      eventType: PRIVILEGED_EVENT_TYPES.USER_SUSPENDED,
      actor: 'admin-super',
      target: { type: 'user', id: 'usr-bad-actor' },
      reason: 'Malicious upload activity',
      timestamp: t1,
    });

    assert.equal(ev2.sequence, 1);
    assert.equal(ev2.previousHash, ev1.recordHash);
    assert.equal(ev2.eventDomain, EVENT_DOMAINS.PRIVILEGED);

    const ev3 = await appendFinancialEvent(mockDb, {
      operationId: 'refund-303',
      eventType: FINANCIAL_EVENT_TYPES.REFUND_EXECUTED,
      actor: 'system-reconciler',
      financialDetails: { amount: 45, asset: 'XLM', recipient: 'GBUYER' },
      target: { type: 'refund', id: 'ref-303' },
      timestamp: t2,
    });

    assert.equal(ev3.sequence, 2);
    assert.equal(ev3.previousHash, ev2.recordHash);

    const integrity = verifyLedgerIntegrity(mockDb._records);
    assert.equal(integrity.valid, true);
    assert.equal(integrity.totalRecords, 3);
    assert.equal(integrity.anomaly, null);
  });

  test('detects unauthorized content modification in ledger chain', async () => {
    const mockDb = createMockLedgerDb();
    const t0 = new Date('2026-10-15T12:00:00Z');
    const t1 = new Date('2026-10-15T12:01:00Z');

    await appendFinancialEvent(mockDb, {
      operationId: 'payout-orig',
      eventType: FINANCIAL_EVENT_TYPES.PAYOUT_SETTLED,
      actor: 'system-treasury',
      financialDetails: { amount: 100, asset: 'XLM' },
      target: { type: 'payout', id: 'p1' },
      timestamp: t0,
    });

    await appendPrivilegedEvent(mockDb, {
      operationId: 'role-orig',
      eventType: PRIVILEGED_EVENT_TYPES.ROLE_CHANGE,
      actor: 'admin',
      target: { type: 'user', id: 'u1' },
      timestamp: t1,
    });

    // Tamper with record 0 financialDetails amount from 100 to 9999
    const tampered = JSON.parse(JSON.stringify(mockDb._records));
    tampered[0].financialDetails.amount = 9999;

    const integrity = verifyLedgerIntegrity(tampered);
    assert.equal(integrity.valid, false);
    assert.equal(integrity.anomaly.type, 'CONTENT_MODIFICATION');
    assert.equal(integrity.anomaly.sequence, 0);
  });

  test('detects broken chain links when previousHash is altered', async () => {
    const mockDb = createMockLedgerDb();
    const t0 = new Date('2026-10-15T12:00:00Z');
    const t1 = new Date('2026-10-15T12:01:00Z');

    await appendFinancialEvent(mockDb, {
      operationId: 'p1',
      eventType: FINANCIAL_EVENT_TYPES.PAYOUT_SETTLED,
      actor: 'system',
      financialDetails: { amount: 10, asset: 'XLM' },
      target: { type: 'payout', id: 'p1' },
      timestamp: t0,
    });

    await appendFinancialEvent(mockDb, {
      operationId: 'p2',
      eventType: FINANCIAL_EVENT_TYPES.PAYOUT_SETTLED,
      actor: 'system',
      financialDetails: { amount: 20, asset: 'XLM' },
      target: { type: 'payout', id: 'p2' },
      timestamp: t1,
    });

    const tampered = JSON.parse(JSON.stringify(mockDb._records));
    tampered[1].previousHash = 'a'.repeat(64);

    const integrity = verifyLedgerIntegrity(tampered);
    assert.equal(integrity.valid, false);
    assert.equal(integrity.anomaly.type, 'BROKEN_CHAIN');
    assert.equal(integrity.anomaly.sequence, 1);
  });

  test('detects sequence gaps caused by deleted or omitted entries', async () => {
    const mockDb = createMockLedgerDb();
    for (let i = 0; i < 3; i += 1) {
      await appendFinancialEvent(mockDb, {
        operationId: `p-${i}`,
        eventType: FINANCIAL_EVENT_TYPES.PAYOUT_SETTLED,
        actor: 'system',
        financialDetails: { amount: 10 * (i + 1), asset: 'XLM' },
        target: { type: 'payout', id: `p-${i}` },
        timestamp: new Date(`2026-10-15T12:0${i}:00Z`),
      });
    }

    // Delete sequence 1
    const tampered = [mockDb._records[0], mockDb._records[2]];
    const integrity = verifyLedgerIntegrity(tampered);
    assert.equal(integrity.valid, false);
    assert.equal(integrity.anomaly.type, 'SEQUENCE_GAP');
    assert.equal(integrity.anomaly.expectedSequence, 1);
  });

  test('detects chronological inversions in timestamps', async () => {
    const mockDb = createMockLedgerDb();
    await appendFinancialEvent(mockDb, {
      operationId: 'p1',
      eventType: FINANCIAL_EVENT_TYPES.PAYOUT_SETTLED,
      actor: 'system',
      financialDetails: { amount: 10, asset: 'XLM' },
      target: { type: 'payout', id: 'p1' },
      timestamp: new Date('2026-10-15T12:00:00Z'),
    });

    // Attempting to append an earlier timestamp must be rejected
    await assert.rejects(
      async () => {
        await appendFinancialEvent(mockDb, {
          operationId: 'p2-retroactive',
          eventType: FINANCIAL_EVENT_TYPES.PAYOUT_SETTLED,
          actor: 'system',
          financialDetails: { amount: 20, asset: 'XLM' },
          target: { type: 'payout', id: 'p2' },
          timestamp: new Date('2026-10-15T11:59:00Z'), // Older than p1
        });
      },
      (err) => {
        assert.match(err.message, /Chronological inversion/);
        return true;
      }
    );
  });

  test('ensures idempotent appends return existing record without creating forks', async () => {
    const mockDb = createMockLedgerDb();
    const t0 = new Date('2026-10-15T12:00:00Z');

    const first = await appendFinancialEvent(mockDb, {
      operationId: 'idempotent-op-1',
      eventType: FINANCIAL_EVENT_TYPES.PURCHASE_SETTLEMENT,
      actor: 'buyer-alice',
      financialDetails: { amount: 50, asset: 'XLM' },
      target: { type: 'purchase', id: 'purch-1' },
      timestamp: t0,
    });

    const second = await appendFinancialEvent(mockDb, {
      operationId: 'idempotent-op-1',
      eventType: FINANCIAL_EVENT_TYPES.PURCHASE_SETTLEMENT,
      actor: 'buyer-alice',
      financialDetails: { amount: 50, asset: 'XLM' },
      target: { type: 'purchase', id: 'purch-1' },
      timestamp: t0,
    });

    assert.equal(first.recordHash, second.recordHash);
    assert.equal(mockDb._records.length, 1);
  });

  test('exports ledger in CSV and JSON formats with verifiable integrity receipt', async () => {
    const mockDb = createMockLedgerDb();
    await appendFinancialEvent(mockDb, {
      operationId: 'export-ev-1',
      eventType: FINANCIAL_EVENT_TYPES.PAYOUT_SETTLED,
      actor: 'treasury',
      financialDetails: { amount: 500, asset: 'XLM' },
      target: { type: 'payout', id: 'exp-1' },
      timestamp: new Date('2026-10-15T12:00:00Z'),
    });

    await appendPrivilegedEvent(mockDb, {
      operationId: 'export-ev-2',
      eventType: PRIVILEGED_EVENT_TYPES.CONTENT_TAKEDOWN,
      actor: 'moderator-bob',
      target: { type: 'material', id: 'mat-flagged' },
      reason: 'DMCA notice',
      timestamp: new Date('2026-10-15T12:05:00Z'),
    });

    // JSON export
    const jsonExport = await exportLedger(mockDb, { format: 'json' });
    assert.equal(jsonExport.format, 'json');
    assert.equal(jsonExport.records.length, 2);
    assert.equal(jsonExport.receipt.recordCount, 2);
    assert.equal(jsonExport.receipt.isCompleteChainVerified, true);
    assert.ok(jsonExport.receipt.exportChecksum);

    // CSV export
    const csvExport = await exportLedger(mockDb, { format: 'csv' });
    assert.equal(csvExport.format, 'csv');
    assert.ok(csvExport.data.includes('sequence,timestamp,eventDomain,eventType'));
    assert.ok(csvExport.data.includes('export-ev-1'));
    assert.ok(csvExport.data.includes('export-ev-2'));
    assert.equal(csvExport.receipt.recordCount, 2);
  });
});
