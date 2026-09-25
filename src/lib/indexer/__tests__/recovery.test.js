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

function makeDb(existingHashes = []) {
  return {
    collection: () => ({
      find: () => ({
        toArray: async () => existingHashes.map((h) => ({ chainTxHash: h })),
      }),
    }),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('findMissingTransactions', () => {
  it('returns operations not present in the database', async () => {
    withFailover.mockImplementation((fn) =>
      fn({
        payments: () => ({
          forAccount: () => ({
            limit: () => ({
              order: () => ({
                call: async () => ({
                  records: [
                    { transaction_hash: 'hash-a', from: 'GA', to: 'GB', amount: '10' },
                    { transaction_hash: 'hash-b', from: 'GA', to: 'GB', amount: '20' },
                  ],
                }),
              }),
            }),
          }),
        }),
      })
    );

    const db = makeDb(['hash-a']); // hash-a is already indexed
    const missing = await findMissingTransactions({ db, accountId: 'GACCOUNT' });

    expect(missing).toHaveLength(1);
    expect(missing[0].transaction_hash).toBe('hash-b');
  });

  it('returns empty array when all transactions are already indexed', async () => {
    withFailover.mockImplementation((fn) =>
      fn({
        payments: () => ({
          forAccount: () => ({
            limit: () => ({
              order: () => ({
                call: async () => ({
                  records: [{ transaction_hash: 'hash-x', from: 'GA', to: 'GB', amount: '5' }],
                }),
              }),
            }),
          }),
        }),
      })
    );

    const db = makeDb(['hash-x']);
    const missing = await findMissingTransactions({ db, accountId: 'GACCOUNT' });
    expect(missing).toHaveLength(0);
  });

  it('throws when accountId is not provided', async () => {
    await expect(findMissingTransactions({ db: makeDb(), accountId: '' })).rejects.toThrow(
      'accountId is required'
    );
  });
});

describe('reprocessMissingTransactions', () => {
  it('counts recovered transactions correctly', async () => {
    applyIndexedEvent.mockResolvedValue({ skipped: false, eventId: 'e1' });

    const result = await reprocessMissingTransactions({
      db: makeDb(),
      operations: [{ transaction_hash: 'hash-new', from: 'GA', to: 'GB', amount: '10' }],
    });

    expect(result.recovered).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('counts skipped transactions when already indexed', async () => {
    applyIndexedEvent.mockResolvedValue({ skipped: true, eventId: 'e2' });

    const result = await reprocessMissingTransactions({
      db: makeDb(),
      operations: [{ transaction_hash: 'hash-dup', from: 'GA', to: 'GB', amount: '5' }],
    });

    expect(result.skipped).toBe(1);
    expect(result.recovered).toBe(0);
  });

  it('collects errors without throwing when applyIndexedEvent fails', async () => {
    applyIndexedEvent.mockRejectedValue(new Error('db write failed'));

    const result = await reprocessMissingTransactions({
      db: makeDb(),
      operations: [{ transaction_hash: 'hash-bad', from: 'GA', to: 'GB', amount: '1' }],
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('hash-bad');
  });
});

describe('runRecovery', () => {
  it('returns zero counts when no transactions are missing', async () => {
    withFailover.mockImplementation((fn) =>
      fn({
        payments: () => ({
          forAccount: () => ({
            limit: () => ({ order: () => ({ call: async () => ({ records: [] }) }) }),
          }),
        }),
      })
    );

    const result = await runRecovery({ db: makeDb(), accountId: 'GACCOUNT' });
    expect(result.recovered).toBe(0);
    expect(result.skipped).toBe(0);
  });
});
