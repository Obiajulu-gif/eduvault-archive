import { describe, it, expect } from 'vitest';
import {
  DRIFT_CATEGORIES,
  reconcileBalances,
} from '../balanceReconciler.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');

function baseInput(overrides = {}) {
  return {
    now: NOW,
    ledgerEntries: [
      { id: 'led-1', account: 'alice', asset: 'USDC', amount: 100, timestamp: NOW },
    ],
    dbRecords: [
      { id: 'db-1', ledgerId: 'led-1', account: 'alice', asset: 'USDC', amount: 100, status: 'confirmed', updatedAt: NOW },
    ],
    userBalances: [
      { account: 'alice', asset: 'USDC', balance: 100, updatedAt: NOW },
    ],
    ...overrides,
  };
}

describe('reconcileBalances', () => {
  it('reports a clean run when ledger, database, and balances agree', () => {
    const report = reconcileBalances(baseInput());

    expect(report.clean).toBe(true);
    expect(report.readOnly).toBe(true);
    expect(report.totals.findings).toBe(0);
    for (const category of DRIFT_CATEGORIES) {
      expect(report.categories[category].count).toBe(0);
      expect(report.categories[category].items).toEqual([]);
    }
  });

  it('detects a missing database projection for a ledger entry', () => {
    const report = reconcileBalances(baseInput({ dbRecords: [] }));

    expect(report.clean).toBe(false);
    expect(report.categories.missing.count).toBe(1);
    const [item] = report.categories.missing.items;
    expect(item.kind).toBe('db_record');
    expect(item.ledgerId).toBe('led-1');
    expect(item.amounts.ledger).toBe(100);
    expect(item.repairHint).toMatch(/backfill/i);
  });

  it('detects duplicate database records referencing the same ledger entry', () => {
    const report = reconcileBalances(
      baseInput({
        dbRecords: [
          { id: 'db-1', ledgerId: 'led-1', account: 'alice', asset: 'USDC', amount: 100, status: 'confirmed', updatedAt: NOW },
          { id: 'db-2', ledgerId: 'led-1', account: 'alice', asset: 'USDC', amount: 100, status: 'confirmed', updatedAt: NOW },
        ],
        userBalances: [],
      }),
    );

    expect(report.categories.duplicate.count).toBeGreaterThanOrEqual(1);
    const kinds = report.categories.duplicate.items.map((i) => i.kind);
    expect(kinds).toContain('db_ledger_ref');
    expect(report.categories.duplicate.items[0].repairHint).toMatch(/collapse|merge/i);
  });

  it('detects a stale pending database record beyond the threshold', () => {
    const staleAt = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);
    const report = reconcileBalances(
      baseInput({
        dbRecords: [
          { id: 'db-1', ledgerId: 'led-1', account: 'alice', asset: 'USDC', amount: 100, status: 'pending', updatedAt: staleAt },
        ],
        thresholds: { stalePendingHours: 24 },
      }),
    );

    expect(report.categories.stale.count).toBe(1);
    const [item] = report.categories.stale.items;
    expect(item.kind).toBe('pending_db_record');
    expect(item.id).toBe('db-1');
    expect(item.repairHint).toMatch(/reconciler|confirmation/i);
  });

  it('detects an inconsistent user-facing balance that disagrees with the ledger', () => {
    const report = reconcileBalances(
      baseInput({
        userBalances: [
          { account: 'alice', asset: 'USDC', balance: 75, updatedAt: NOW },
        ],
      }),
    );

    expect(report.categories.inconsistent.count).toBe(1);
    const [item] = report.categories.inconsistent.items;
    expect(item.kind).toBe('user_balance');
    expect(item.amounts.ledger).toBe(100);
    expect(item.amounts.balance).toBe(75);
    expect(item.repairHint).toMatch(/rebuild/i);
  });

  it('is read-only and deterministic: inputs are not mutated and output is stable', () => {
    const input = baseInput();
    const snapshot = JSON.parse(JSON.stringify(input));

    const first = reconcileBalances(input);
    const second = reconcileBalances(JSON.parse(JSON.stringify(input)));

    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.readOnly).toBe(true);
  });
});
