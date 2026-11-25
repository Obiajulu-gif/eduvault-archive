import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createInvariantMonitor,
  VIOLATION_SEVERITY,
  MONITOR_EVENT,
} from './invariantMonitor.js';

function makeCollection(docs) {
  const chain = {
    find: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue(docs),
  };
  return chain;
}

describe('createInvariantMonitor', () => {
  let monitor;
  let emitted;

  beforeEach(() => {
    emitted = [];
    monitor = createInvariantMonitor({ emit: (ev, payload) => emitted.push({ ev, payload }) });
  });

  describe('record()', () => {
    it('stores a violation and returns it with generated id', () => {
      const v = monitor.record({ type: 'BALANCE_NEGATIVE', address: 'GX123' });
      expect(v.id).toMatch(/^inv-/);
      expect(v.severity).toBe(VIOLATION_SEVERITY.WARNING);
      expect(v.recordedAt).toBeDefined();
    });

    it('emits VIOLATION_RECORDED event', () => {
      monitor.record({ type: 'TEST' });
      expect(emitted[0].ev).toBe(MONITOR_EVENT.VIOLATION_RECORDED);
    });

    it('respects explicit severity', () => {
      const v = monitor.record({ type: 'X', severity: VIOLATION_SEVERITY.CRITICAL });
      expect(v.severity).toBe(VIOLATION_SEVERITY.CRITICAL);
    });

    it('throws on non-object input', () => {
      expect(() => monitor.record('bad')).toThrow(TypeError);
      expect(() => monitor.record(null)).toThrow(TypeError);
    });

    it('respects maxViolations ring buffer', () => {
      const m = createInvariantMonitor({ maxViolations: 3 });
      for (let i = 0; i < 5; i++) m.record({ type: 'T' });
      expect(m.getViolations().length).toBe(3);
      expect(m.stats().totalRecorded).toBe(5);
    });
  });

  describe('getViolations()', () => {
    beforeEach(() => {
      monitor.record({ type: 'A', severity: VIOLATION_SEVERITY.CRITICAL });
      monitor.record({ type: 'B', severity: VIOLATION_SEVERITY.WARNING });
      monitor.record({ type: 'A', severity: VIOLATION_SEVERITY.INFO });
    });

    it('returns all violations by default', () => {
      expect(monitor.getViolations().length).toBe(3);
    });

    it('filters by severity', () => {
      const critical = monitor.getViolations({ severity: VIOLATION_SEVERITY.CRITICAL });
      expect(critical.length).toBe(1);
      expect(critical[0].type).toBe('A');
    });

    it('filters by type', () => {
      expect(monitor.getViolations({ type: 'A' }).length).toBe(2);
    });

    it('respects limit', () => {
      expect(monitor.getViolations({ limit: 2 }).length).toBe(2);
    });

    it('filters by since date', () => {
      const future = new Date(Date.now() + 10_000).toISOString();
      expect(monitor.getViolations({ since: future }).length).toBe(0);
    });
  });

  describe('stats()', () => {
    it('returns zero stats on empty monitor', () => {
      const s = monitor.stats();
      expect(s.buffered).toBe(0);
      expect(s.totalRecorded).toBe(0);
    });

    it('accumulates bySeverity counts', () => {
      monitor.record({ type: 'X', severity: VIOLATION_SEVERITY.CRITICAL });
      monitor.record({ type: 'X', severity: VIOLATION_SEVERITY.CRITICAL });
      monitor.record({ type: 'Y', severity: VIOLATION_SEVERITY.WARNING });
      const s = monitor.stats();
      expect(s.bySeverity[VIOLATION_SEVERITY.CRITICAL]).toBe(2);
      expect(s.bySeverity[VIOLATION_SEVERITY.WARNING]).toBe(1);
    });
  });

  describe('runBalanceScan()', () => {
    it('requires walletCollection', async () => {
      await expect(monitor.runBalanceScan()).rejects.toThrow(TypeError);
    });

    it('emits SCAN_STARTED and SCAN_COMPLETED', async () => {
      const col = makeCollection([]);
      await monitor.runBalanceScan({ walletCollection: col });
      expect(emitted.some((e) => e.ev === MONITOR_EVENT.SCAN_STARTED)).toBe(true);
      expect(emitted.some((e) => e.ev === MONITOR_EVENT.SCAN_COMPLETED)).toBe(true);
    });

    it('records BALANCE_NEGATIVE violation for negative balance', async () => {
      const col = makeCollection([{ _id: '1', address: 'GTEST', balance: '-5', currency: 'XLM' }]);
      const result = await monitor.runBalanceScan({ walletCollection: col });
      expect(result.violations).toBe(1);
      const v = monitor.getViolations({ type: 'BALANCE_NEGATIVE' });
      expect(v.length).toBe(1);
      expect(v[0].severity).toBe(VIOLATION_SEVERITY.CRITICAL);
    });

    it('records BALANCE_NON_NUMERIC for NaN balance', async () => {
      const col = makeCollection([{ _id: '2', address: 'GTEST2', balance: 'invalid' }]);
      await monitor.runBalanceScan({ walletCollection: col });
      expect(monitor.getViolations({ type: 'BALANCE_NON_NUMERIC' }).length).toBe(1);
    });

    it('records BALANCE_PENDING_MISMATCH when pending ledger inconsistent', async () => {
      const col = makeCollection([{
        _id: '3',
        address: 'GTEST3',
        balance: '100',
        pendingDebits: 10,
        pendingCredits: 2,
        pendingBalance: 5, // mismatch: net=8, stored=5
      }]);
      await monitor.runBalanceScan({ walletCollection: col });
      expect(monitor.getViolations({ type: 'BALANCE_PENDING_MISMATCH' }).length).toBe(1);
    });

    it('returns zero violations for healthy balances', async () => {
      const col = makeCollection([
        { _id: '4', address: 'GA', balance: '100', currency: 'XLM' },
        { _id: '5', address: 'GB', balance: '0', currency: 'XLM' },
      ]);
      const r = await monitor.runBalanceScan({ walletCollection: col });
      expect(r.violations).toBe(0);
    });

    it('emits SCAN_ERROR and rethrows on collection failure', async () => {
      const col = {
        find: () => ({ sort: () => ({ limit: () => ({ toArray: () => Promise.reject(new Error('db down')) }) }) }),
      };
      await expect(monitor.runBalanceScan({ walletCollection: col })).rejects.toThrow('db down');
      expect(emitted.some((e) => e.ev === MONITOR_EVENT.SCAN_ERROR)).toBe(true);
    });

    it('calls onProgress callback', async () => {
      const col = makeCollection([{ _id: '1', address: 'G', balance: '10' }]);
      const progress = vi.fn();
      await monitor.runBalanceScan({ walletCollection: col, onProgress: progress });
      expect(progress).toHaveBeenCalledWith(expect.objectContaining({ scanned: expect.any(Number) }));
    });
  });

  describe('runOwnershipScan()', () => {
    it('requires materialsCollection', async () => {
      await expect(monitor.runOwnershipScan()).rejects.toThrow(TypeError);
    });

    it('records OWNERSHIP_MISSING for documents with no owner', async () => {
      const col = makeCollection([{ _id: 'm1', title: 'Test', status: 'active' }]);
      const r = await monitor.runOwnershipScan({ materialsCollection: col });
      expect(r.violations).toBe(1);
      expect(monitor.getViolations({ type: 'OWNERSHIP_MISSING' }).length).toBe(1);
    });

    it('records INFO for owned resource in blocked state', async () => {
      const col = makeCollection([{ _id: 'm2', creator: 'GXOWNER', status: 'archived' }]);
      await monitor.runOwnershipScan({ materialsCollection: col });
      expect(monitor.getViolations({ type: 'OWNERSHIP_ON_INACTIVE_RESOURCE' }).length).toBe(1);
    });

    it('no violations for healthy owned active resource', async () => {
      const col = makeCollection([{ _id: 'm3', creator: 'GXOWNER', status: 'active' }]);
      const r = await monitor.runOwnershipScan({ materialsCollection: col });
      expect(r.violations).toBe(0);
    });

    it('emits SCAN_STARTED and SCAN_COMPLETED', async () => {
      const col = makeCollection([]);
      await monitor.runOwnershipScan({ materialsCollection: col });
      expect(emitted.some((e) => e.ev === MONITOR_EVENT.SCAN_STARTED && e.payload.type === 'ownership')).toBe(true);
      expect(emitted.some((e) => e.ev === MONITOR_EVENT.SCAN_COMPLETED && e.payload.type === 'ownership')).toBe(true);
    });
  });

  describe('clear()', () => {
    it('resets buffer and totalRecorded', () => {
      monitor.record({ type: 'X' });
      monitor.clear();
      expect(monitor.stats().buffered).toBe(0);
      expect(monitor.stats().totalRecorded).toBe(0);
    });
  });
});
