import { describe, expect, it } from 'vitest';
import {
  createQuarantineRecord,
  finalizeQuarantine,
  getQuarantineDecision,
  replayQuarantine,
  rescanStaleClean,
  runScanner,
  verifyMaterialNotQuarantined,
  QUARANTINE_STATES,
} from './quarantine';

function getPath(obj, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/** A tiny but genuinely generic query matcher covering exactly what this
 * test file's callers need: equality, dotted paths (`scanResult.foo`),
 * $exists, $ne, $in, $or, and $gt — enough to faithfully exercise
 * quarantine.js's real MongoDB queries rather than hand-special-casing
 * each caller's shape. */
function matchesQuery(record, query) {
  return Object.entries(query).every(([key, condition]) => {
    if (key === '$or') {
      return condition.some((sub) => matchesQuery(record, sub));
    }
    const value = getPath(record, key);
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      if ('$exists' in condition) {
        const exists = value !== undefined;
        if (exists !== condition.$exists) return false;
      }
      if ('$ne' in condition && value === condition.$ne) return false;
      if ('$in' in condition && !condition.$in.includes(value)) return false;
      if ('$gt' in condition && !(value > condition.$gt)) return false;
      return true;
    }
    return value === condition;
  });
}

function createFakeDb() {
  const records = [];
  const collection = {
    createIndex: async () => {},
    insertOne: async (record) => {
      records.push({ ...record, _id: records.length + 1 });
    },
    findOne: async (query) => records.find((record) => matchesQuery(record, query)) || null,
    // MongoDB Node driver v6 returns the matched document directly (or
    // null) from findOneAndUpdate — not wrapped in `{ value }`, which was
    // the v4/v5 shape. This mock previously returned the old shape, which
    // is exactly how quarantine.js's real findOneAndUpdate().value bug
    // went undetected: the mock and the real (buggy) code agreed with each
    // other, just both against the wrong API.
    findOneAndUpdate: async (query, update) => {
      const record = records.find((item) => matchesQuery(item, query));
      if (!record) return null;
      Object.assign(record, update.$set);
      record.attemptCount += update.$inc?.attemptCount || 0;
      return record;
    },
    updateOne: async (query, update) => {
      const record = records.find((item) => item._id === query._id || matchesQuery(item, query));
      if (record) Object.assign(record, update.$set);
      return { modifiedCount: record ? 1 : 0 };
    },
    find: (query = {}) => {
      let results = records.filter((record) => matchesQuery(record, query));
      const api = {
        sort(spec) {
          const [[field, dir]] = Object.entries(spec);
          results = [...results].sort((a, b) => {
            const av = getPath(a, field);
            const bv = getPath(b, field);
            return av < bv ? -dir : av > bv ? dir : 0;
          });
          return api;
        },
        limit(n) {
          results = results.slice(0, n);
          return api;
        },
        [Symbol.asyncIterator]() {
          return results[Symbol.iterator]();
        },
      };
      return api;
    },
  };

  return { collection: () => collection, records };
}

describe('finalizeQuarantine', () => {
  it('returns the updated document directly, not wrapped in a driver-version-specific envelope', async () => {
    const db = createFakeDb();
    await createQuarantineRecord({
      db,
      contentHash: 'QmDirectReturn',
      byteHash: 'sha256:abc',
      fileName: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      uploaderAddress: 'GCREATOR',
    });

    const result = await finalizeQuarantine({
      db,
      contentHash: 'QmDirectReturn',
      state: QUARANTINE_STATES.CLEAN,
      scanner: 'test-scanner',
      scanResult: { verdict: 'clean' },
    });

    // This is the exact assertion missing before this fix: with the old,
    // wrong `{ value }`-unwrapping code, `result` here would be
    // `undefined`, not a document with a `byteHash` — silently breaking
    // every caller (notably runScanner's manifest-recording branch, gated
    // on `finalized?.byteHash`).
    expect(result).toBeTruthy();
    expect(result.byteHash).toBe('sha256:abc');
    expect(result.state).toBe(QUARANTINE_STATES.CLEAN);
  });

  it('returns null (not a truthy empty envelope) when no matching pending record exists', async () => {
    const db = createFakeDb();
    const result = await finalizeQuarantine({
      db,
      contentHash: 'QmNeverCreated',
      state: QUARANTINE_STATES.CLEAN,
    });
    expect(result).toBeNull();
  });
});

describe('replayQuarantine', () => {
  it('re-runs scanning so a stuck record reaches a terminal state', async () => {
    const db = createFakeDb();
    await createQuarantineRecord({
      db,
      contentHash: 'QmRecovered',
      fileName: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      uploaderAddress: 'GCREATOR',
    });
    await finalizeQuarantine({
      db,
      contentHash: 'QmRecovered',
      state: QUARANTINE_STATES.TIMEOUT,
    });

    const results = await replayQuarantine(db, 100, {
      scannerImpl: {
        name: 'test-scanner',
        scan: async () => ({ infected: false }),
      },
      timeoutMs: 1000,
    });

    expect(results).toEqual(['QmRecovered']);
    expect((await getQuarantineDecision(db, 'QmRecovered')).state).toBe(QUARANTINE_STATES.CLEAN);
  });
});

describe('runScanner — provenance and indeterminate verdicts (issue #637)', () => {
  it('records signatureVersion and scanDurationMs on a clean verdict', async () => {
    const db = createFakeDb();
    await createQuarantineRecord({
      db,
      contentHash: 'QmProvenance',
      fileName: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      uploaderAddress: 'GCREATOR',
    });

    await runScanner({
      db,
      contentHash: 'QmProvenance',
      scannerImpl: {
        name: 'test-scanner',
        signatureVersion: '111',
        scan: async () => ({ infected: false, engineVersion: '1.2.3' }),
      },
    });

    const decision = await getQuarantineDecision(db, 'QmProvenance');
    expect(decision.scanResult.signatureVersion).toBe('111');
    expect(decision.scanResult.engineVersion).toBe('1.2.3');
    expect(typeof decision.scanResult.scanDurationMs).toBe('number');
    expect(decision.scanResult.scanStartedAt).toBeInstanceOf(Date);
    expect(decision.scanResult.scanCompletedAt).toBeInstanceOf(Date);
  });

  it('routes an indeterminate verdict to manual_review, distinguishable from a crash', async () => {
    const db = createFakeDb();
    await createQuarantineRecord({
      db,
      contentHash: 'QmIndeterminate',
      fileName: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      uploaderAddress: 'GCREATOR',
    });

    await runScanner({
      db,
      contentHash: 'QmIndeterminate',
      scannerImpl: {
        name: 'test-scanner',
        scan: async () => ({ indeterminate: true, notes: 'engine could not classify this file type' }),
      },
    });

    const decision = await getQuarantineDecision(db, 'QmIndeterminate');
    expect(decision.state).toBe(QUARANTINE_STATES.MANUAL_REVIEW);
    expect(decision.scanResult.verdict).toBe('indeterminate');
  });

  it('still routes a genuine scanner crash to scanner_unavailable, not indeterminate', async () => {
    const db = createFakeDb();
    await createQuarantineRecord({
      db,
      contentHash: 'QmCrash',
      fileName: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      uploaderAddress: 'GCREATOR',
    });

    await runScanner({
      db,
      contentHash: 'QmCrash',
      scannerImpl: {
        name: 'test-scanner',
        scan: async () => {
          throw new Error('engine segfault');
        },
      },
    });

    const decision = await getQuarantineDecision(db, 'QmCrash');
    expect(decision.state).toBe(QUARANTINE_STATES.SCANNER_UNAVAILABLE);
    expect(decision.reason).toBe('scanner_outage');
  });
});

describe('verifyMaterialNotQuarantined — staleness (issue #637)', () => {
  it('allows publish when the recorded signature version matches current', async () => {
    const db = createFakeDb();
    await createQuarantineRecord({
      db,
      contentHash: 'QmFresh',
      fileName: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      uploaderAddress: 'GCREATOR',
    });
    await runScanner({
      db,
      contentHash: 'QmFresh',
      scannerImpl: { name: 'test-scanner', signatureVersion: '200', scan: async () => ({ infected: false }) },
    });

    const result = await verifyMaterialNotQuarantined(db, 'QmFresh', { currentSignatureVersion: '200' });
    expect(result.allowed).toBe(true);
  });

  it('blocks publish for a clean verdict recorded against a superseded signature version', async () => {
    const db = createFakeDb();
    await createQuarantineRecord({
      db,
      contentHash: 'QmStale',
      fileName: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      uploaderAddress: 'GCREATOR',
    });
    await runScanner({
      db,
      contentHash: 'QmStale',
      scannerImpl: { name: 'test-scanner', signatureVersion: '100', scan: async () => ({ infected: false }) },
    });

    const result = await verifyMaterialNotQuarantined(db, 'QmStale', { currentSignatureVersion: '200' });
    expect(result.allowed).toBe(false);
    expect(result.stale).toBe(true);
  });

  it('does not treat missing signatureVersion info as stale (backward compatible)', async () => {
    const db = createFakeDb();
    await createQuarantineRecord({
      db,
      contentHash: 'QmNoVersionInfo',
      fileName: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      uploaderAddress: 'GCREATOR',
    });
    await finalizeQuarantine({ db, contentHash: 'QmNoVersionInfo', state: QUARANTINE_STATES.CLEAN, scanResult: { verdict: 'clean' } });

    const result = await verifyMaterialNotQuarantined(db, 'QmNoVersionInfo', { currentSignatureVersion: '200' });
    expect(result.allowed).toBe(true);
  });

  it('preserves pre-#637 behavior when no currentSignatureVersion is passed at all', async () => {
    const db = createFakeDb();
    await createQuarantineRecord({
      db,
      contentHash: 'QmLegacyCaller',
      fileName: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      uploaderAddress: 'GCREATOR',
    });
    await runScanner({
      db,
      contentHash: 'QmLegacyCaller',
      scannerImpl: { name: 'test-scanner', signatureVersion: '100', scan: async () => ({ infected: false }) },
    });

    const result = await verifyMaterialNotQuarantined(db, 'QmLegacyCaller');
    expect(result.allowed).toBe(true);
  });
});

describe('rescanStaleClean (issue #637)', () => {
  it('rescans clean items whose signature version is behind current', async () => {
    const db = createFakeDb();
    for (const hash of ['QmA', 'QmB']) {
      await createQuarantineRecord({ db, contentHash: hash, fileName: 'f.pdf', mimeType: 'application/pdf', sizeBytes: 10, uploaderAddress: 'G1' });
      await runScanner({
        db,
        contentHash: hash,
        scannerImpl: { name: 'old-scanner', signatureVersion: '100', scan: async () => ({ infected: false }) },
      });
    }

    const result = await rescanStaleClean(db, {
      currentSignatureVersion: '200',
      scannerImpl: { name: 'new-scanner', signatureVersion: '200', scan: async () => ({ infected: false }) },
    });

    expect(result.rescanned.sort()).toEqual(['QmA', 'QmB']);
    const a = await getQuarantineDecision(db, 'QmA');
    expect(a.scanResult.signatureVersion).toBe('200');
  });

  it('does not rescan items already at the current signature version', async () => {
    const db = createFakeDb();
    await createQuarantineRecord({ db, contentHash: 'QmUpToDate', fileName: 'f.pdf', mimeType: 'application/pdf', sizeBytes: 10, uploaderAddress: 'G1' });
    await runScanner({
      db,
      contentHash: 'QmUpToDate',
      scannerImpl: { name: 'scanner', signatureVersion: '200', scan: async () => ({ infected: false }) },
    });

    const result = await rescanStaleClean(db, {
      currentSignatureVersion: '200',
      scannerImpl: { name: 'scanner', signatureVersion: '200', scan: async () => ({ infected: false }) },
    });

    expect(result.rescanned).toEqual([]);
  });

  it('is bounded by limit and returns a resumable cursor', async () => {
    const db = createFakeDb();
    for (const hash of ['QmA', 'QmB', 'QmC']) {
      await createQuarantineRecord({ db, contentHash: hash, fileName: 'f.pdf', mimeType: 'application/pdf', sizeBytes: 10, uploaderAddress: 'G1' });
      await runScanner({
        db,
        contentHash: hash,
        scannerImpl: { name: 'old-scanner', signatureVersion: '100', scan: async () => ({ infected: false }) },
      });
    }

    const firstBatch = await rescanStaleClean(db, {
      currentSignatureVersion: '200',
      limit: 2,
      scannerImpl: { name: 'new-scanner', signatureVersion: '200', scan: async () => ({ infected: false }) },
    });

    expect(firstBatch.rescanned).toEqual(['QmA', 'QmB']);
    expect(firstBatch.nextCursor).toBe('QmB');

    const secondBatch = await rescanStaleClean(db, {
      currentSignatureVersion: '200',
      limit: 2,
      cursorContentHash: firstBatch.nextCursor,
      scannerImpl: { name: 'new-scanner', signatureVersion: '200', scan: async () => ({ infected: false }) },
    });

    expect(secondBatch.rescanned).toEqual(['QmC']);
    expect(secondBatch.nextCursor).toBeNull();
  });

  it('throws without currentSignatureVersion', async () => {
    const db = createFakeDb();
    await expect(rescanStaleClean(db, {})).rejects.toThrow(/currentSignatureVersion/);
  });
});
