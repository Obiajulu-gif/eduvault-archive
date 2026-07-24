import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/stellar/horizonClient', () => ({
  withFailover: vi.fn(),
}));
vi.mock('@/lib/indexer/stellarIndexer', () => ({
  applyIndexedEvent: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { withFailover } from '@/lib/stellar/horizonClient';
import { applyIndexedEvent } from '@/lib/indexer/stellarIndexer';
import { findMissingTransactions, reprocessMissingTransactions, runRecovery } from '../recovery';

const ACCOUNT = 'GACCOUNT';

/**
 * @param purchases rows the `purchases` collection should contain. `find` backs
 *   the audit query, `findOne` backs the per-operation purchase lookup; both
 *   match on either tx-hash field so the double behaves like the real $or query.
 */
function makeDb(purchases = []) {
  const matches = (doc, hashes) =>
    hashes.includes(doc.chainTxHash) || hashes.includes(doc.transactionHash);

  return {
    collection: () => ({
      find: (query) => {
        const hashes = query.$or.flatMap((clause) =>
          clause.chainTxHash?.$in ?? clause.transactionHash?.$in ?? []
        );
        return { toArray: async () => purchases.filter((p) => matches(p, hashes)) };
      },
      findOne: async (query) => {
        const hashes = query.$or.flatMap((clause) =>
          clause.chainTxHash?.$in ?? clause.transactionHash?.$in ?? []
        );
        return purchases.find((p) => matches(p, hashes)) || null;
      },
    }),
  };
}

function mockPayments(records) {
  withFailover.mockImplementation((fn) =>
    fn({
      payments: () => ({
        forAccount: () => ({
          limit: () => ({ order: () => ({ call: async () => ({ records }) }) }),
        }),
      }),
    })
  );
}

beforeEach(() => vi.clearAllMocks());

describe('findMissingTransactions', () => {
  it('returns inbound payments with no settled purchase', async () => {
    mockPayments([
      { transaction_hash: 'hash-a', from: 'GBUYER', to: ACCOUNT, amount: '10' },
      { transaction_hash: 'hash-b', from: 'GBUYER', to: ACCOUNT, amount: '20' },
    ]);

    const db = makeDb([{ chainTxHash: 'hash-a', status: 'settled', materialId: 'm-1' }]);
    const missing = await findMissingTransactions({ db, accountId: ACCOUNT });

    expect(missing).toHaveLength(1);
    expect(missing[0].transaction_hash).toBe('hash-b');
  });

  it('treats a purchase recorded under transactionHash as already settled', async () => {
    // The checkout path writes `transactionHash`; only the indexer writes
    // `chainTxHash`. Consulting one field made every app-path purchase look
    // missing, which is what drove recovery to re-create existing rows.
    mockPayments([{ transaction_hash: 'hash-app', from: 'GBUYER', to: ACCOUNT, amount: '10' }]);

    const db = makeDb([{ transactionHash: 'hash-app', status: 'confirmed', materialId: 'm-1' }]);
    expect(await findMissingTransactions({ db, accountId: ACCOUNT })).toHaveLength(0);
  });

  it('still reports a payment whose purchase never reached a completed status', async () => {
    mockPayments([{ transaction_hash: 'hash-pending', from: 'GBUYER', to: ACCOUNT, amount: '10' }]);

    const db = makeDb([{ transactionHash: 'hash-pending', status: 'pending', materialId: 'm-1' }]);
    const missing = await findMissingTransactions({ db, accountId: ACCOUNT });

    expect(missing).toHaveLength(1);
  });

  it('ignores outbound payments such as refunds', async () => {
    // forAccount() returns both directions. Treating an outbound payment as a
    // purchase records the platform account as the buyer of its own refund.
    mockPayments([{ transaction_hash: 'hash-refund', from: ACCOUNT, to: 'GLEARNER', amount: '10' }]);

    expect(await findMissingTransactions({ db: makeDb(), accountId: ACCOUNT })).toHaveLength(0);
  });

  it('throws when accountId is not provided', async () => {
    await expect(findMissingTransactions({ db: makeDb(), accountId: '' })).rejects.toThrow(
      'accountId is required'
    );
  });
});

describe('reprocessMissingTransactions', () => {
  const operation = { transaction_hash: 'hash-new', from: 'GBUYER', to: ACCOUNT, amount: '10' };

  it('re-indexes a payment using the materialId from its purchase', async () => {
    applyIndexedEvent.mockResolvedValue({ skipped: false, eventId: 'e1' });

    const db = makeDb([
      { transactionHash: 'hash-new', status: 'pending', materialId: 'm-42', buyerAddress: 'gbuyer' },
    ]);
    const result = await reprocessMissingTransactions({ db, operations: [operation] });

    expect(result.recovered).toBe(1);
    expect(result.orphaned).toHaveLength(0);
    expect(applyIndexedEvent).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ materialId: 'm-42', type: 'purchase.completed' })
    );
  });

  it('orphans a payment with no matching purchase instead of writing one', async () => {
    // The regression this guards: an unmatched payment used to be projected as
    // a purchase and entitlement with materialId undefined, granting access to
    // a material that does not exist.
    const result = await reprocessMissingTransactions({
      db: makeDb(),
      operations: [operation],
    });

    expect(applyIndexedEvent).not.toHaveBeenCalled();
    expect(result.recovered).toBe(0);
    expect(result.orphaned).toEqual([
      expect.objectContaining({ transactionHash: 'hash-new', reason: 'no-matching-purchase' }),
    ]);
  });

  it('orphans a payment whose purchase carries no materialId', async () => {
    const db = makeDb([{ transactionHash: 'hash-new', status: 'pending' }]);
    const result = await reprocessMissingTransactions({ db, operations: [operation] });

    expect(applyIndexedEvent).not.toHaveBeenCalled();
    expect(result.orphaned).toEqual([
      expect.objectContaining({ reason: 'purchase-missing-material-id' }),
    ]);
  });

  it('counts skipped transactions when already indexed', async () => {
    applyIndexedEvent.mockResolvedValue({ skipped: true, eventId: 'e2' });

    const db = makeDb([{ transactionHash: 'hash-new', status: 'pending', materialId: 'm-1' }]);
    const result = await reprocessMissingTransactions({ db, operations: [operation] });

    expect(result.skipped).toBe(1);
    expect(result.recovered).toBe(0);
  });

  it('collects errors without throwing when applyIndexedEvent fails', async () => {
    applyIndexedEvent.mockRejectedValue(new Error('db write failed'));

    const db = makeDb([{ transactionHash: 'hash-new', status: 'pending', materialId: 'm-1' }]);
    const result = await reprocessMissingTransactions({ db, operations: [operation] });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('hash-new');
  });
});

describe('runRecovery', () => {
  it('returns zero counts when no transactions are missing', async () => {
    mockPayments([]);

    const result = await runRecovery({ db: makeDb(), accountId: ACCOUNT });
    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.orphaned).toEqual([]);
  });
});
