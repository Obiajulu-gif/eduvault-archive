import { describe, expect, it } from 'vitest';
import {
  buildContentManifest,
  hashManifest,
  verifyPublishBinding,
} from '@/lib/backend/contentManifest';

describe('TOCTOU content binding', () => {
  it('rejects publish when byte hash changes after clean scan', () => {
    const manifest = buildContentManifest({
      byteHash: 'scanned-byte-hash',
      sizeBytes: 2048,
      mediaType: 'application/pdf',
      cid: 'QmScanned',
      creator: 'gcreator',
      scanner: 'ipfs-fetch-scanner',
      generation: 1,
    });

    const binding = verifyPublishBinding({
      manifest,
      material: { storageKey: 'QmScanned' },
      quarantineRecord: {
        contentHash: 'QmScanned',
        byteHash: 'different-byte-hash',
        sizeBytes: 2048,
        mimeType: 'application/pdf',
      },
    });

    expect(binding.valid).toBe(false);
    expect(binding.reason).toContain('byteHash');
  });

  it('rejects metadata substitution via mismatched manifest hash fields', () => {
    const manifest = buildContentManifest({
      byteHash: 'hash-a',
      sizeBytes: 100,
      mediaType: 'application/pdf',
      cid: 'QmA',
      creator: 'gcreator',
      scanner: 'scanner',
      generation: 1,
    });

    const tampered = { ...manifest, sizeBytes: 999 };
    expect(hashManifest(manifest)).not.toBe(hashManifest(tampered));
  });
});
