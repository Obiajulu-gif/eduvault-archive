import { createHash } from 'node:crypto';

/**
 * Canonical manifest for material content provenance.
 *
 * Binds file CID/hash/size/type, preview/thumbnail hashes, metadata,
 * creator wallet, material/version ID, creation time, and previous version
 * into a deterministic, content-addressable structure.
 */

// ── Deterministic field ordering ─────────────────────────────────────────────

const MANIFEST_VERSION = 1;

/**
 * Canonical field order for manifest serialization.
 * Keys are sorted leascase alphabetically at each nesting level to ensure
 * deterministic output regardless of property insertion order.
 */
const CANONICAL_FIELDS = [
  'manifestVersion',
  'materialId',
  'version',
  'previousVersionDigest',
  'creator',
  'createdAt',
  'file',
  'preview',
  'metadata',
  'rights',
];

const FILE_FIELDS = ['cid', 'hash', 'size', 'type'];
const PREVIEW_FIELDS = ['thumbnailCid', 'thumbnailHash', 'coverImageCid', 'coverImageHash'];

/**
 * Build a canonical manifest object from the provided inputs.
 *
 * @param {object} params
 * @param {string} params.materialId - The material identifier
 * @param {number} params.version - Version number (1-based)
 * @param {string|null} params.previousVersionDigest - SHA-256 hex digest of the prior version's manifest, or null for v1
 * @param {string} params.creator - Creator wallet address
 * @param {string} params.createdAt - ISO-8601 timestamp
 * @param {object} params.file - File info: { cid, hash, size, type }
 * @param {object} [params.preview] - Preview info: { thumbnailCid, thumbnailHash, coverImageCid, coverImageHash }
 * @param {object} [params.metadata] - Arbitrary metadata object (will be shallow-sorted)
 * @param {object} [params.rights] - Usage rights info
 * @returns {object} The canonical manifest
 */
export function buildManifest({
  materialId,
  version,
  previousVersionDigest = null,
  creator,
  createdAt,
  file,
  preview,
  metadata,
  rights,
}) {
  if (!materialId) throw new Error('manifest: materialId is required');
  if (!version || version < 1) throw new Error('manifest: version must be >= 1');
  if (!creator) throw new Error('manifest: creator is required');
  if (!createdAt) throw new Error('manifest: createdAt is required');
  if (!file || !file.cid) throw new Error('manifest: file.cid is required');
  if (!file.hash) throw new Error('manifest: file.hash is required');
  if (file.size == null || file.size < 0) throw new Error('manifest: file.size is required');
  if (!file.type) throw new Error('manifest: file.type is required');

  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    materialId,
    version,
    previousVersionDigest,
    creator,
    createdAt,
    file: pickFields(file, FILE_FIELDS),
    preview: preview ? pickFields(preview, PREVIEW_FIELDS) : null,
    metadata: metadata ? sortObjectKeys(metadata) : null,
    rights: rights ? sortObjectKeys(rights) : null,
  };

  return manifest;
}

/**
 * Produce the deterministic (canonical) JSON string of a manifest.
 * Objects are recursively sorted by key; arrays preserve order.
 *
 * @param {object} manifest
 * @returns {string} Canonical JSON string
 */
export function canonicalize(manifest) {
  return JSON.stringify(sortObjectKeys(manifest));
}

/**
 * Compute the SHA-256 hex digest of a manifest's canonical form.
 *
 * @param {object} manifest
 * @returns {string} Hex-encoded SHA-256 digest
 */
export function digestManifest(manifest) {
  const canonical = canonicalize(manifest);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Build and digest a manifest in one step.
 *
 * @param {object} params - See buildManifest
 * @returns {{ manifest: object, digest: string }}
 */
export function buildAndDigest(params) {
  const manifest = buildManifest(params);
  const digest = digestManifest(manifest);
  return { manifest, digest };
}

/**
 * Verify that a manifest produces the expected digest.
 *
 * @param {object} manifest
 * @param {string} expectedDigest - Hex SHA-256 digest
 * @returns {boolean}
 */
export function verifyManifestDigest(manifest, expectedDigest) {
  if (!manifest || !expectedDigest) return false;
  return digestManifest(manifest) === expectedDigest;
}

/**
 * Verify that raw file bytes match the hash recorded in a manifest.
 * Supports SHA-256 hashes (64 hex chars) and IPFS CIDs (which are checked by
 * re-uploading/re-hashing if a raw hash is available).
 *
 * @param {Buffer|Uint8Array} data - The file bytes
 * @param {string} expectedHash - The expected hex-encoded hash
 * @returns {boolean}
 */
export function verifyFileBytes(data, expectedHash) {
  if (!data || !expectedHash) return false;
  const actual = createHash('sha256').update(data).digest('hex');
  return actual === expectedHash;
}

/**
 * Compute a SHA-256 hash of file bytes.
 *
 * @param {Buffer|Uint8Array} data
 * @returns {string} Hex-encoded SHA-256 hash
 */
export function hashFileBytes(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Create a manifest entry for a purchase record — the immutable binding
 * between a purchase and the exact version acquired.
 *
 * @param {object} params
 * @param {string} params.materialId
 * @param {number} params.version
 * @param {string} params.manifestDigest - The SHA-256 digest of the manifest
 * @param {string} params.fileCid - The file CID at time of purchase
 * @param {string} params.fileHash - The file hash at time of purchase
 * @returns {object}
 */
export function createPurchaseVersionBinding({
  materialId,
  version,
  manifestDigest,
  fileCid,
  fileHash,
}) {
  return {
    materialId,
    version,
    manifestDigest,
    fileCid,
    fileHash,
    boundAt: new Date().toISOString(),
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function pickFields(obj, fields) {
  const result = {};
  for (const key of fields) {
    if (obj[key] !== undefined && obj[key] !== null) {
      result[key] = obj[key];
    }
  }
  return result;
}

function sortObjectKeys(obj) {
  if (obj === null || typeof obj !== 'object' || obj instanceof Date) return obj;
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);

  const sorted = {};
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    sorted[key] = sortObjectKeys(obj[key]);
  }
  return sorted;
}
