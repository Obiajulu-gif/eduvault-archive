import crypto from 'node:crypto';

const MANIFEST_VERSION = 1;

function canonicalize(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

/**
 * Build a canonical content manifest binding scan evidence to uploaded bytes.
 * @param {object} params
 * @returns {object}
 */
export function buildContentManifest({
  byteHash,
  sizeBytes,
  mediaType,
  cid,
  creator,
  scanner,
  scannerVersion = null,
  scannedAt = new Date().toISOString(),
  generation = 1,
}) {
  return {
    version: MANIFEST_VERSION,
    byteHash,
    sizeBytes,
    mediaType,
    cid,
    creator: String(creator).toLowerCase(),
    scanner,
    scannerVersion,
    scannedAt,
    generation,
  };
}

export function hashManifest(manifest) {
  return crypto.createHash('sha256').update(canonicalize(manifest)).digest('hex');
}

export function hashBytes(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function attestManifest(manifest, secret) {
  if (!secret) {
    throw new Error('Content manifest attestation secret is required');
  }
  const manifestHash = hashManifest(manifest);
  const attestation = crypto.createHmac('sha256', secret).update(manifestHash).digest('hex');
  return { manifestHash, attestation };
}

export function verifyManifestAttestation(manifest, attestation, secret) {
  if (!manifest || !attestation || !secret) return false;
  const { attestation: expected } = attestManifest(manifest, secret);
  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(attestation, 'hex');
  return (
    expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

/**
 * Reject publish when material fields diverge from attested scan manifest.
 */
export function verifyPublishBinding({ manifest, material, quarantineRecord }) {
  if (!manifest || !quarantineRecord) {
    return { valid: false, reason: 'Missing content manifest or quarantine record' };
  }

  const cid = material.storageKey || material.ipfsCid || material.cid || material.contentHash;
  const checks = [
    { field: 'byteHash', expected: quarantineRecord.byteHash, actual: manifest.byteHash },
    { field: 'cid', expected: quarantineRecord.contentHash, actual: manifest.cid },
    { field: 'sizeBytes', expected: quarantineRecord.sizeBytes, actual: manifest.sizeBytes },
    { field: 'mediaType', expected: quarantineRecord.mimeType, actual: manifest.mediaType },
    { field: 'materialCid', expected: cid, actual: manifest.cid },
  ];

  for (const check of checks) {
    if (check.expected == null || check.actual == null) continue;
    if (String(check.expected) !== String(check.actual)) {
      return {
        valid: false,
        reason: `Content binding mismatch on ${check.field}`,
      };
    }
  }

  return { valid: true, manifestHash: hashManifest(manifest) };
}

export function getManifestSecret() {
  return process.env.CONTENT_MANIFEST_SECRET || process.env.JWT_SECRET || null;
}
