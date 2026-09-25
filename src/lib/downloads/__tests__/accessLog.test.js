import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recordDownloadAccess } from '../accessLog';

function fakeDb() {
  const inserted = [];
  return {
    inserted,
    collection: () => ({
      insertOne: async (doc) => {
        inserted.push(doc);
        return { insertedId: 'fake-id' };
      },
    }),
  };
}

describe('recordDownloadAccess — audit-safe persisted access log (#675)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('persists a capability_issued event with the expected fields', async () => {
    const db = fakeDb();
    await recordDownloadAccess(db, {
      event: 'capability_issued',
      materialId: 'material-1',
      buyerAddress: 'GBUYER',
      decisionSource: 'on_chain',
      byteRangeStart: 0,
      byteRangeEnd: 1023,
      capabilityId: 'jti-123',
      ipAddress: '203.0.113.5',
    });

    expect(db.inserted).toHaveLength(1);
    const entry = db.inserted[0];
    expect(entry.event).toBe('capability_issued');
    expect(entry.materialId).toBe('material-1');
    expect(entry.buyerAddress).toBe('GBUYER');
    expect(entry.decisionSource).toBe('on_chain');
    expect(entry.byteRangeStart).toBe(0);
    expect(entry.byteRangeEnd).toBe(1023);
    expect(entry.capabilityId).toBe('jti-123');
    expect(entry.ipAddress).toBe('203.0.113.5');
    expect(entry.timestamp).toBeInstanceOf(Date);
  });

  it('persists an access_denied event with a denial reason', async () => {
    const db = fakeDb();
    await recordDownloadAccess(db, {
      event: 'access_denied',
      materialId: 'material-1',
      buyerAddress: 'GBUYER',
      denialReason: 'not_entitled',
      ipAddress: '203.0.113.5',
    });

    const entry = db.inserted[0];
    expect(entry.event).toBe('access_denied');
    expect(entry.denialReason).toBe('not_entitled');
    expect(entry.decisionSource).toBeNull();
  });

  it('never persists a capability token or a raw file/gateway URL — no such fields exist on the entry', async () => {
    const db = fakeDb();
    await recordDownloadAccess(db, {
      event: 'capability_issued',
      materialId: 'material-1',
      buyerAddress: 'GBUYER',
      capabilityId: 'jti-123',
      // Even if a caller mistakenly passed these, the entry shape below
      // only ever sets fields explicitly named in the function body — this
      // test guards against a future edit accidentally spreading raw input.
      token: 'super-secret-capability-token',
      fileUrl: 'https://gateway.example/ipfs/Qm...?cap=super-secret-capability-token',
    });

    const entry = db.inserted[0];
    expect(entry.token).toBeUndefined();
    expect(entry.fileUrl).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain('super-secret-capability-token');
  });

  it('does not throw when the insert fails — logging must never break the download itself', async () => {
    const db = {
      collection: () => ({
        insertOne: async () => {
          throw new Error('connection reset');
        },
      }),
    };

    await expect(
      recordDownloadAccess(db, { event: 'capability_issued', materialId: 'm1', buyerAddress: 'GBUYER' })
    ).resolves.toBeUndefined();
  });

  it('defaults optional fields to null rather than leaving them undefined', async () => {
    const db = fakeDb();
    await recordDownloadAccess(db, { event: 'capability_issued', materialId: 'material-1', buyerAddress: 'GBUYER' });

    const entry = db.inserted[0];
    expect(entry.decisionSource).toBeNull();
    expect(entry.denialReason).toBeNull();
    expect(entry.byteRangeStart).toBeNull();
    expect(entry.byteRangeEnd).toBeNull();
    expect(entry.capabilityId).toBeNull();
    expect(entry.ipAddress).toBeNull();
  });
});
