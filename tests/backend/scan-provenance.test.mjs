import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFakeCollection, createFakeDb } from '../../src/lib/refunds/__tests__/fakeMongo.js';
import { processSideEffectIntent } from '../../src/lib/backend/sideEffectWorker.js';
import {
  SCAN_PROVENANCE_COLLECTION,
  SCAN_PROVENANCE_ERROR_CODES,
  SCAN_PROVENANCE_VERSION,
  ScanProvenanceError,
  buildScanProvenance,
  computeSha256,
  recordScanProvenance,
  verifyScanProvenance,
} from '../../src/lib/publishing/scanProvenance.js';

const BYTES = Buffer.from('issue-1175-exact-bytes');
const BYTE_HASH = computeSha256(BYTES);
const CONTENT_HASH = 'bafy-scan-1175';
const SCANNER = 'fake-scanner';
const SIGNATURE_VERSION = 'sig-2026.11.1';
const SCANNED_AT = '2026-11-23T00:00:00.000Z';
const ACTOR = { id: 'worker-1175', role: 'system' };

function baseParams(overrides = {}) {
  return {
    bytes: BYTES,
    byteHash: BYTE_HASH,
    contentHash: CONTENT_HASH,
    sizeBytes: BYTES.length,
    scanner: SCANNER,
    signatureVersion: SIGNATURE_VERSION,
    scannedAt: SCANNED_AT,
    actor: ACTOR,
    scanResult: {
      verdict: 'clean',
      threats: [],
      signatureVersion: SIGNATURE_VERSION,
      scannerName: SCANNER,
      artifactHash: CONTENT_HASH,
    },
    ...overrides,
  };
}

function makeContext() {
  const quarantine = createFakeCollection({ uniqueKey: (doc) => doc.contentHash });
  const scanProvenance = createFakeCollection({
    uniqueKey: (doc) => doc.idempotencyKey,
  });
  const db = createFakeDb({
    quarantine,
    [SCAN_PROVENANCE_COLLECTION]: scanProvenance,
  });
  return { db, quarantine, scanProvenance };
}

async function seedQuarantine(quarantine) {
  await quarantine.insertOne({
    contentHash: CONTENT_HASH,
    byteHash: BYTE_HASH,
    sizeBytes: BYTES.length,
    mimeType: 'text/plain',
    uploaderAddress: 'GCREATOR1175',
    state: 'pending',
  });
}

function assertCode(expectedCode) {
  return (error) => error instanceof ScanProvenanceError && error.code === expectedCode;
}

describe('scan provenance (#1175)', () => {
  it('builds, verifies, and records provenance bound to exact bytes', async () => {
    const { db, scanProvenance } = makeContext();
    await seedQuarantine(db.collection('quarantine'));

    const built = buildScanProvenance(baseParams());
    assert.equal(built.version, SCAN_PROVENANCE_VERSION);
    assert.equal(built.byteHash, BYTE_HASH);
    assert.equal(built.contentHash, CONTENT_HASH);
    assert.equal(built.sizeBytes, BYTES.length);
    assert.equal(built.scanner, SCANNER);
    assert.equal(built.signatureVersion, SIGNATURE_VERSION);
    assert.equal(built.scannedAt, SCANNED_AT);
    assert.match(built.evidenceId, /^[0-9a-f]{64}$/);
    assert.equal(
      built.idempotencyKey,
      `scan-provenance:${SCAN_PROVENANCE_VERSION}:${built.evidenceId}`
    );
    assert.equal(
      verifyScanProvenance({
        provenance: built,
        bytes: BYTES,
        byteHash: BYTE_HASH,
        contentHash: CONTENT_HASH,
        sizeBytes: BYTES.length,
      }),
      true
    );

    const result = await recordScanProvenance({ db, ...baseParams() });
    assert.equal(result.outcome, 'recorded');
    assert.equal(result.applied, true);
    const stored = await scanProvenance.findOne({ idempotencyKey: built.idempotencyKey });
    assert.equal(stored.evidenceId, built.evidenceId);
    assert.equal(stored.byteHash, BYTE_HASH);
    assert.equal(stored.contentHash, CONTENT_HASH);
    assert.equal(stored.provenance.scannedAt, SCANNED_AT);
    assert.equal(stored.actor.role, 'system');
  });

  it('rejects exact-byte hash mismatches with a stable code', () => {
    const tampered = Buffer.from(BYTES);
    tampered[0] = tampered[0] ^ 0xff;
    const expected = assertCode(SCAN_PROVENANCE_ERROR_CODES.BYTE_HASH_MISMATCH);

    assert.throws(() => buildScanProvenance(baseParams({ bytes: tampered })), expected);
    const built = buildScanProvenance(baseParams());
    assert.throws(
      () => verifyScanProvenance({
        provenance: built,
        bytes: tampered,
        byteHash: BYTE_HASH,
        contentHash: CONTENT_HASH,
        sizeBytes: BYTES.length,
      }),
      expected
    );
  });

  it('rejects CID and size mismatches with stable codes', () => {
    const built = buildScanProvenance(baseParams());
    const cidCode = assertCode(SCAN_PROVENANCE_ERROR_CODES.CID_MISMATCH);
    const sizeCode = assertCode(SCAN_PROVENANCE_ERROR_CODES.SIZE_MISMATCH);

    assert.throws(() => buildScanProvenance(baseParams({ cid: 'bafy-substituted' })), cidCode);
    assert.throws(
      () => buildScanProvenance(baseParams({ expectedContentHash: 'bafy-substituted' })),
      cidCode
    );
    assert.throws(() => buildScanProvenance(baseParams({ sizeBytes: BYTES.length + 1 })), sizeCode);
    assert.throws(
      () => verifyScanProvenance({
        provenance: built,
        bytes: BYTES,
        byteHash: BYTE_HASH,
        contentHash: 'bafy-substituted',
        sizeBytes: BYTES.length,
      }),
      cidCode
    );
    assert.throws(
      () => verifyScanProvenance({
        provenance: built,
        bytes: BYTES,
        byteHash: BYTE_HASH,
        contentHash: CONTENT_HASH,
        sizeBytes: BYTES.length + 1,
      }),
      sizeCode
    );
  });

  it('is idempotent on replay even when the timestamp changes', async () => {
    const { db, scanProvenance } = makeContext();
    await seedQuarantine(db.collection('quarantine'));

    const first = await recordScanProvenance({ db, ...baseParams() });
    const second = await recordScanProvenance(baseParams({
      db,
      scannedAt: '2026-11-23T02:00:00.000Z',
    }));

    assert.equal(first.outcome, 'recorded');
    assert.equal(second.outcome, 'replayed');
    assert.equal(second.applied, false);
    assert.equal(second.record._id, first.record._id);
    assert.equal(second.provenance.evidenceId, first.provenance.evidenceId);
    assert.equal(second.provenance.scannedAt, SCANNED_AT);
    assert.equal(scanProvenance.docs.length, 1);
  });

  it('rejects unauthorized actors', async () => {
    const { db } = makeContext();
    await seedQuarantine(db.collection('quarantine'));

    await assert.rejects(
      recordScanProvenance(baseParams({
        db,
        actor: { id: 'mallory', role: 'learner' },
      })),
      assertCode(SCAN_PROVENANCE_ERROR_CODES.UNAUTHORIZED_ACTOR)
    );
    await assert.rejects(
      recordScanProvenance(baseParams({ db, actor: 'random-user' })),
      assertCode(SCAN_PROVENANCE_ERROR_CODES.UNAUTHORIZED_ACTOR)
    );
  });

  it('routes current and legacy scan intents through the provenance handler without network', async () => {
    const { db, scanProvenance } = makeContext();
    await seedQuarantine(db.collection('quarantine'));

    let calls = 0;
    const recordProvenance = async (params) => {
      calls += 1;
      return recordScanProvenance(params);
    };
    const fetchBytes = async () => {
      throw new Error('network fetch must not be used when bytes are supplied');
    };
    const options = {
      db,
      bytes: BYTES,
      fetchBytes,
      recordProvenance,
      actor: ACTOR,
      now: new Date(SCANNED_AT),
    };
    const scanResult = {
      verdict: 'clean',
      threats: [],
      signatureVersion: SIGNATURE_VERSION,
      scannerName: SCANNER,
      artifactHash: CONTENT_HASH,
    };

    const current = await processSideEffectIntent({
      _id: 'intent-current',
      sourceId: CONTENT_HASH,
      intent: {
        type: 'indexer',
        action: 'scan_content',
        payload: {
          contentHash: CONTENT_HASH,
          sizeBytes: BYTES.length,
          mimeType: 'text/plain',
          scanResult,
        },
      },
    }, options);

    const legacy = await processSideEffectIntent({
      _id: 'intent-legacy',
      sourceId: CONTENT_HASH,
      intent: {
        type: 'indexer',
        channel: 'scan_content',
        payload: {
          action: 'scan',
          contentHash: CONTENT_HASH,
          sizeBytes: BYTES.length,
          mimeType: 'text/plain',
          scanResult,
        },
      },
    }, options);

    assert.equal(calls, 2);
    assert.equal(current.outcome, 'recorded');
    assert.equal(legacy.outcome, 'replayed');
    assert.equal(legacy.provenance.evidenceId, current.provenance.evidenceId);
    assert.equal(scanProvenance.docs.length, 1);

    const emptyDb = createFakeDb({
      quarantine: createFakeCollection(),
      [SCAN_PROVENANCE_COLLECTION]: scanProvenance,
    });
    await assert.rejects(
      processSideEffectIntent({
        _id: 'intent-incomplete',
        intent: {
          type: 'indexer',
          channel: 'scan_content',
          payload: { contentHash: CONTENT_HASH },
        },
      }, { ...options, db: emptyDb }),
      assertCode(SCAN_PROVENANCE_ERROR_CODES.INVALID_INPUT)
    );
  });
});
