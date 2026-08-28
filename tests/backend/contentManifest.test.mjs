import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attestManifest,
  buildContentManifest,
  hashBytes,
  hashManifest,
  verifyManifestAttestation,
  verifyPublishBinding,
} from '../../src/lib/backend/contentManifest.js';

test('content manifest canonical hash is stable', () => {
  const manifest = buildContentManifest({
    byteHash: 'abc123',
    sizeBytes: 100,
    mediaType: 'application/pdf',
    cid: 'QmTest',
    creator: 'GBUYER',
    scanner: 'ipfs-fetch-scanner',
    scannerVersion: '1.0.0',
    scannedAt: '2026-01-01T00:00:00.000Z',
    generation: 1,
  });

  const first = hashManifest(manifest);
  const second = hashManifest({ ...manifest });
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('manifest attestation verifies with shared secret', () => {
  const manifest = buildContentManifest({
    byteHash: hashBytes(Buffer.from('hello')),
    sizeBytes: 5,
    mediaType: 'text/plain',
    cid: 'QmHello',
    creator: 'gcreator',
    scanner: 'test-scanner',
    generation: 1,
  });
  const { attestation } = attestManifest(manifest, 'test-secret');
  assert.equal(verifyManifestAttestation(manifest, attestation, 'test-secret'), true);
  assert.equal(verifyManifestAttestation(manifest, attestation, 'wrong-secret'), false);
});

test('publish binding rejects substituted CID after scan', () => {
  const manifest = buildContentManifest({
    byteHash: 'byte-a',
    sizeBytes: 10,
    mediaType: 'application/pdf',
    cid: 'QmOriginal',
    creator: 'gcreator',
    scanner: 'scanner',
    generation: 1,
  });
  const result = verifyPublishBinding({
    manifest,
    material: { storageKey: 'QmSubstituted' },
    quarantineRecord: {
      contentHash: 'QmOriginal',
      byteHash: 'byte-a',
      sizeBytes: 10,
      mimeType: 'application/pdf',
    },
  });
  assert.equal(result.valid, false);
  assert.match(result.reason, /materialCid/);
});

test('rescans create new manifest generations without mutating prior hash', () => {
  const base = {
    byteHash: 'byte-a',
    sizeBytes: 10,
    mediaType: 'application/pdf',
    cid: 'QmOriginal',
    creator: 'gcreator',
    scanner: 'scanner',
    scannedAt: '2026-01-01T00:00:00.000Z',
  };
  const gen1 = buildContentManifest({ ...base, generation: 1, scannerVersion: '1.0.0' });
  const gen2 = buildContentManifest({ ...base, generation: 2, scannerVersion: '1.0.1' });
  assert.notEqual(hashManifest(gen1), hashManifest(gen2));
});
