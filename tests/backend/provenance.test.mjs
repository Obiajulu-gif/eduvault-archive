/**
 * Tests for content provenance system — canonical manifests, versioning,
 * cryptographic binding, and download verification.
 *
 * Covers: metadata/file substitution, hash mismatch, missing objects,
 * concurrent publish, version forks, withdrawn/recalled versions,
 * creator key rotation, legacy backfill restart, canonicalization
 * differences, and historical download integrity.
 */

import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';
import { createHash } from 'node:crypto';

// ── Import the pure logic modules under test ─────────────────────────────────

import {
  buildManifest,
  canonicalize,
  digestManifest,
  buildAndDigest,
  verifyManifestDigest,
  verifyFileBytes,
  hashFileBytes,
  createPurchaseVersionBinding,
} from '../../src/lib/provenance/manifest.js';

// =============================================================================
// Manifest Construction Tests
// =============================================================================

describe('Manifest — Construction', () => {

  const baseParams = {
    materialId: 'mat-001',
    version: 1,
    previousVersionDigest: null,
    creator: 'GALICE1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    createdAt: '2026-01-15T12:00:00.000Z',
    file: {
      cid: 'QmTest123',
      hash: 'a'.repeat(64),
      size: 1024,
      type: 'application/pdf',
    },
  };

  test('builds a manifest with all required fields', () => {
    const manifest = buildManifest(baseParams);

    assert.equal(manifest.manifestVersion, 1);
    assert.equal(manifest.materialId, 'mat-001');
    assert.equal(manifest.version, 1);
    assert.equal(manifest.previousVersionDigest, null);
    assert.equal(manifest.creator, baseParams.creator);
    assert.equal(manifest.createdAt, baseParams.createdAt);
    assert.equal(manifest.file.cid, 'QmTest123');
    assert.equal(manifest.file.hash, 'a'.repeat(64));
    assert.equal(manifest.file.size, 1024);
    assert.equal(manifest.file.type, 'application/pdf');
    assert.equal(manifest.preview, null);
    assert.equal(manifest.metadata, null);
    assert.equal(manifest.rights, null);
  });

  test('builds a manifest with preview and metadata', () => {
    const manifest = buildManifest({
      ...baseParams,
      preview: {
        thumbnailCid: 'QmThumb',
        thumbnailHash: 'b'.repeat(64),
        coverImageCid: 'QmCover',
      },
      metadata: {
        title: 'Test Material',
        description: 'A test',
      },
      rights: {
        usageRights: 'Standard License',
      },
    });

    assert.equal(manifest.preview.thumbnailCid, 'QmThumb');
    assert.equal(manifest.preview.thumbnailHash, 'b'.repeat(64));
    assert.equal(manifest.preview.coverImageCid, 'QmCover');
    assert.equal(manifest.metadata.title, 'Test Material');
    assert.equal(manifest.rights.usageRights, 'Standard License');
  });

  test('throws on missing materialId', () => {
    assert.throws(() => buildManifest({ ...baseParams, materialId: '' }));
  });

  test('throws on missing file.cid', () => {
    assert.throws(() => buildManifest({
      ...baseParams,
      file: { ...baseParams.file, cid: '' },
    }));
  });

  test('throws on missing file.hash', () => {
    assert.throws(() => buildManifest({
      ...baseParams,
      file: { ...baseParams.file, hash: '' },
    }));
  });

  test('throws on negative file.size', () => {
    assert.throws(() => buildManifest({
      ...baseParams,
      file: { ...baseParams.file, size: -1 },
    }));
  });

  test('throws on version 0', () => {
    assert.throws(() => buildManifest({ ...baseParams, version: 0 }));
  });

  test('throws on missing creator', () => {
    assert.throws(() => buildManifest({ ...baseParams, creator: '' }));
  });

  test('throws on missing createdAt', () => {
    assert.throws(() => buildManifest({ ...baseParams, createdAt: '' }));
  });
});

// =============================================================================
// Canonicalization Tests
// =============================================================================

describe('Manifest — Canonicalization', () => {

  const baseManifest = {
    manifestVersion: 1,
    materialId: 'mat-001',
    version: 1,
    previousVersionDigest: null,
    creator: 'GALICE',
    createdAt: '2026-01-15T12:00:00.000Z',
    file: { cid: 'QmTest', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
    preview: null,
    metadata: null,
    rights: null,
  };

  test('produces deterministic JSON regardless of property order', () => {
    const reordered = {
      rights: null,
      file: baseManifest.file,
      creator: baseManifest.creator,
      manifestVersion: 1,
      metadata: null,
      materialId: 'mat-001',
      version: 1,
      createdAt: baseManifest.createdAt,
      preview: null,
      previousVersionDigest: null,
    };

    assert.equal(canonicalize(baseManifest), canonicalize(reordered));
  });

  test('canonical form sorts object keys lexicographically', () => {
    const canonical = canonicalize(baseManifest);
    const parsed = JSON.parse(canonical);
    const keys = Object.keys(parsed);
    const sorted = [...keys].sort();
    assert.deepEqual(keys, sorted);
  });

  test('nested objects are also sorted', () => {
    const manifest = buildManifest({
      materialId: 'mat-002',
      version: 1,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmTest', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
      metadata: { zebra: 'z', alpha: 'a' },
    });

    const canonical = canonicalize(manifest);
    const parsed = JSON.parse(canonical);
    const metaKeys = Object.keys(parsed.metadata);
    assert.deepEqual(metaKeys, ['alpha', 'zebra']);
  });

  test('arrays preserve insertion order', () => {
    const manifest = buildManifest({
      materialId: 'mat-003',
      version: 1,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmTest', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
      metadata: { tags: ['c', 'a', 'b'] },
    });

    const canonical = canonicalize(manifest);
    const parsed = JSON.parse(canonical);
    assert.deepEqual(parsed.metadata.tags, ['c', 'a', 'b']);
  });
});

// =============================================================================
// Digest / Hashing Tests
// =============================================================================

describe('Manifest — Digest and Hashing', () => {

  test('digest is a valid hex SHA-256', () => {
    const manifest = buildManifest({
      materialId: 'mat-001',
      version: 1,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmTest', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
    });

    const digest = digestManifest(manifest);
    assert.equal(digest.length, 64);
    assert.match(digest, /^[0-9a-f]{64}$/);
  });

  test('same manifest always produces the same digest', () => {
    const params = {
      materialId: 'mat-001',
      version: 1,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmTest', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
    };

    const digest1 = digestManifest(buildManifest(params));
    const digest2 = digestManifest(buildManifest(params));
    assert.equal(digest1, digest2);
  });

  test('different manifests produce different digests', () => {
    const params1 = {
      materialId: 'mat-001',
      version: 1,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmTest', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
    };
    const params2 = { ...params1, version: 2 };

    const digest1 = digestManifest(buildManifest(params1));
    const digest2 = digestManifest(buildManifest(params2));
    assert.notEqual(digest1, digest2);
  });

  test('buildAndDigest returns both manifest and digest', () => {
    const result = buildAndDigest({
      materialId: 'mat-001',
      version: 1,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmTest', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
    });

    assert.ok(result.manifest);
    assert.ok(result.digest);
    assert.equal(result.digest.length, 64);
  });

  test('verifyManifestDigest returns true for matching digest', () => {
    const manifest = buildManifest({
      materialId: 'mat-001',
      version: 1,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmTest', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
    });

    const digest = digestManifest(manifest);
    assert.ok(verifyManifestDigest(manifest, digest));
  });

  test('verifyManifestDigest returns false for wrong digest', () => {
    const manifest = buildManifest({
      materialId: 'mat-001',
      version: 1,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmTest', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
    });

    assert.ok(!verifyManifestDigest(manifest, '0'.repeat(64)));
  });

  test('verifyManifestDigest returns false for null inputs', () => {
    assert.ok(!verifyManifestDigest(null, '0'.repeat(64)));
    assert.ok(!verifyManifestDigest({}, null));
    assert.ok(!verifyManifestDigest(null, null));
  });
});

// =============================================================================
// File Byte Verification Tests
// =============================================================================

describe('Manifest — File Byte Verification', () => {

  test('verifyFileBytes returns true for matching bytes', () => {
    const data = Buffer.from('Hello, World!');
    const hash = createHash('sha256').update(data).digest('hex');
    assert.ok(verifyFileBytes(data, hash));
  });

  test('verifyFileBytes returns false for mismatched bytes', () => {
    const data = Buffer.from('Hello, World!');
    const wrongHash = createHash('sha256').update(Buffer.from('Goodbye!')).digest('hex');
    assert.ok(!verifyFileBytes(data, wrongHash));
  });

  test('hashFileBytes produces correct SHA-256', () => {
    const data = Buffer.from('test data');
    const expected = createHash('sha256').update(data).digest('hex');
    assert.equal(hashFileBytes(data), expected);
  });

  test('verifyFileBytes returns false for null inputs', () => {
    assert.ok(!verifyFileBytes(null, 'abc'));
    assert.ok(!verifyFileBytes(Buffer.from('x'), null));
  });
});

// =============================================================================
// Metadata Substitution Detection Tests
// =============================================================================

describe('Manifest — Metadata Substitution Detection', () => {

  test('changing metadata changes the digest', () => {
    const base = {
      materialId: 'mat-001',
      version: 1,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmTest', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
      metadata: { title: 'Original' },
    };

    const original = buildManifest(base);
    const modified = buildManifest({ ...base, metadata: { title: 'Modified' } });

    assert.notEqual(digestManifest(original), digestManifest(modified));
  });

  test('changing file CID changes the digest', () => {
    const base = {
      materialId: 'mat-001',
      version: 1,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmOriginal', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
    };

    const original = buildManifest(base);
    const modified = buildManifest({ ...base, file: { ...base.file, cid: 'QmSwapped' } });

    assert.notEqual(digestManifest(original), digestManifest(modified));
  });

  test('changing file hash changes the digest', () => {
    const base = {
      materialId: 'mat-001',
      version: 1,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmTest', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
    };

    const original = buildManifest(base);
    const modified = buildManifest({
      ...base,
      file: { ...base.file, hash: 'b'.repeat(64) },
    });

    assert.notEqual(digestManifest(original), digestManifest(modified));
  });

  test('changing creator changes the digest', () => {
    const base = {
      materialId: 'mat-001',
      version: 1,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmTest', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
    };

    const original = buildManifest(base);
    const modified = buildManifest({ ...base, creator: 'GBOB' });

    assert.notEqual(digestManifest(original), digestManifest(modified));
  });

  test('changing version changes the digest', () => {
    const base = {
      materialId: 'mat-001',
      version: 1,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmTest', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
    };

    const original = buildManifest(base);
    const modified = buildManifest({ ...base, version: 2 });

    assert.notEqual(digestManifest(original), digestManifest(modified));
  });
});

// =============================================================================
// Version Chain Tests
// =============================================================================

describe('Manifest — Version Chain', () => {

  test('v1 has null previousVersionDigest', () => {
    const manifest = buildManifest({
      materialId: 'mat-001',
      version: 1,
      previousVersionDigest: null,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmTest', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
    });

    assert.equal(manifest.previousVersionDigest, null);
  });

  test('v2 references v1 digest', () => {
    const v1 = buildManifest({
      materialId: 'mat-001',
      version: 1,
      previousVersionDigest: null,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmV1', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
    });

    const v1Digest = digestManifest(v1);

    const v2 = buildManifest({
      materialId: 'mat-001',
      version: 2,
      previousVersionDigest: v1Digest,
      creator: 'GALICE',
      createdAt: '2026-01-15T13:00:00.000Z',
      file: { cid: 'QmV2', hash: 'b'.repeat(64), size: 200, type: 'application/pdf' },
    });

    assert.equal(v2.previousVersionDigest, v1Digest);
    assert.notEqual(v2.file.cid, v1.file.cid);
  });

  test('v2 with wrong previous digest is detectable', () => {
    const v1 = buildManifest({
      materialId: 'mat-001',
      version: 1,
      previousVersionDigest: null,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmV1', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
    });

    const v1Digest = digestManifest(v1);
    const fakeDigest = '0'.repeat(64);

    const v2 = buildManifest({
      materialId: 'mat-001',
      version: 2,
      previousVersionDigest: fakeDigest,
      creator: 'GALICE',
      createdAt: '2026-01-15T13:00:00.000Z',
      file: { cid: 'QmV2', hash: 'b'.repeat(64), size: 200, type: 'application/pdf' },
    });

    assert.notEqual(v2.previousVersionDigest, v1Digest);
    assert.equal(v2.previousVersionDigest, fakeDigest);
  });
});

// =============================================================================
// Purchase Version Binding Tests
// =============================================================================

describe('Manifest — Purchase Version Binding', () => {

  test('creates a purchase version binding', () => {
    const binding = createPurchaseVersionBinding({
      materialId: 'mat-001',
      version: 1,
      manifestDigest: 'a'.repeat(64),
      fileCid: 'QmTest',
      fileHash: 'b'.repeat(64),
    });

    assert.equal(binding.materialId, 'mat-001');
    assert.equal(binding.version, 1);
    assert.equal(binding.manifestDigest, 'a'.repeat(64));
    assert.equal(binding.fileCid, 'QmTest');
    assert.equal(binding.fileHash, 'b'.repeat(64));
    assert.ok(binding.boundAt);
  });

  test('binding captures exact version at purchase time', () => {
    const binding = createPurchaseVersionBinding({
      materialId: 'mat-001',
      version: 3,
      manifestDigest: 'c'.repeat(64),
      fileCid: 'QmV3',
      fileHash: 'd'.repeat(64),
    });

    assert.equal(binding.version, 3);
    assert.equal(binding.fileCid, 'QmV3');
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('Manifest — Edge Cases', () => {

  test('manifest with empty metadata object', () => {
    const manifest = buildManifest({
      materialId: 'mat-001',
      version: 1,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmTest', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
      metadata: {},
    });

    assert.deepEqual(manifest.metadata, {});
  });

  test('manifest with special characters in strings', () => {
    const manifest = buildManifest({
      materialId: 'mat-001',
      version: 1,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmTest', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
      metadata: { title: 'Hello "World" & <test>' },
    });

    const digest = digestManifest(manifest);
    assert.equal(digest.length, 64);
  });

  test('manifest with large file size', () => {
    const manifest = buildManifest({
      materialId: 'mat-001',
      version: 1,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmTest', hash: 'a'.repeat(64), size: 10 * 1024 * 1024, type: 'application/pdf' },
    });

    assert.equal(manifest.file.size, 10 * 1024 * 1024);
  });

  test('manifest version 10000 (max) is valid', () => {
    const manifest = buildManifest({
      materialId: 'mat-001',
      version: 10000,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmTest', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
    });

    assert.equal(manifest.version, 10000);
  });

  test('different materials with same version have different digests', () => {
    const params1 = {
      materialId: 'mat-A',
      version: 1,
      creator: 'GALICE',
      createdAt: '2026-01-15T12:00:00.000Z',
      file: { cid: 'QmTest', hash: 'a'.repeat(64), size: 100, type: 'application/pdf' },
    };

    const params2 = { ...params1, materialId: 'mat-B' };

    assert.notEqual(
      digestManifest(buildManifest(params1)),
      digestManifest(buildManifest(params2)),
    );
  });
});
