import { describe, expect, it, vi } from 'vitest';
import {
  buildPreviewReport,
  resolveHoldReason,
} from '../../../../scripts/data-retention-cleanup.mjs';

function makeDb(records) {
  const collection = {
    find: vi.fn(() => ({ sort: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue(records) })) })),
    deleteMany: vi.fn(),
  };
  const db = {
    listCollections: vi.fn(({ name }) => ({
      toArray: vi.fn().mockResolvedValue(name === 'sync_events' ? [{ name }] : []),
    })),
    collection: vi.fn(() => collection),
  };
  return { db, collection };
}

describe('operational metadata retention (#1059)', () => {
  it('classifies expired records and preserves explicit operational holds', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const { db, collection } = makeDb([
      { _id: 'old-safe', processedAt: new Date('2025-01-01T00:00:00.000Z') },
      { _id: 'old-held', processedAt: new Date('2025-01-01T00:00:00.000Z'), auditHold: true },
    ]);
    const report = await buildPreviewReport(db, {
      now,
      policies: { sync_events: { retentionDays: 90, protectionCheck: null } },
    });
    expect(report.summary.totalEligible).toBe(1);
    expect(report.summary.totalHeld).toBe(1);
    expect(report.buckets.eligible).toEqual([{ collection: 'sync_events', id: 'old-safe' }]);
    expect(report.buckets.held[0]).toMatchObject({ collection: 'sync_events', id: 'old-held', reason: 'audit_hold' });
    expect(collection.deleteMany).not.toHaveBeenCalled();
  });

  it('recognizes unresolved dispute metadata as a deletion hold', () => {
    expect(resolveHoldReason('sync_events', {
      disputedAt: '2025-01-01T00:00:00.000Z',
      disputeResolvedAt: null,
    }, { now: new Date(), materialIds: new Set() })).toBe('active_dispute');
  });
});
