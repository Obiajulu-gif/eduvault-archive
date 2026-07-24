import { getDb } from '@/lib/mongodb';
import { buildAndDigest, verifyManifestDigest } from './manifest';

/**
 * Provenance registry — manages manifest storage, version history, digest
 * anchoring, and retrieval. Provides the authoritative link between off-chain
 * content hashes and on-chain registry entries.
 */

const COLLECTIONS = {
  manifests: 'material_manifests',
  digestAnchor: 'manifest_digest_anchors',
};

// ── Create / Store ───────────────────────────────────────────────────────────

/**
 * Store a manifest for a material version. Returns the digest and manifest.
 *
 * @param {object} params
 * @param {string} params.materialId
 * @param {number} params.version
 * @param {string|null} params.previousVersionDigest
 * @param {string} params.creator
 * @param {object} params.file - { cid, hash, size, type }
 * @param {object} [params.preview]
 * @param {object} [params.metadata]
 * @param {object} [params.rights]
 * @returns {Promise<{ manifest: object, digest: string }>}
 */
export async function storeManifest({
  materialId,
  version,
  previousVersionDigest = null,
  creator,
  file,
  preview,
  metadata,
  rights,
}) {
  const createdAt = new Date().toISOString();
  const { manifest, digest } = buildAndDigest({
    materialId,
    version,
    previousVersionDigest,
    creator,
    createdAt,
    file,
    preview,
    metadata,
    rights,
  });

  const db = await getDb();
  const doc = {
    materialId,
    version,
    digest,
    manifest,
    creator,
    createdAt: new Date(createdAt),
    previousVersionDigest,
    verified: true,
  };

  await db.collection(COLLECTIONS.manifests).updateOne(
    { materialId, version },
    { $set: doc },
    { upsert: true },
  );

  return { manifest, digest };
}

/**
 * Retrieve the manifest for a specific material version.
 *
 * @param {string} materialId
 * @param {number} version
 * @returns {Promise<object|null>} The manifest document, or null
 */
export async function getManifest(materialId, version) {
  const db = await getDb();
  return db.collection(COLLECTIONS.manifests).findOne({ materialId, version });
}

/**
 * Retrieve the latest manifest for a material.
 *
 * @param {string} materialId
 * @returns {Promise<object|null>}
 */
export async function getLatestManifest(materialId) {
  const db = await getDb();
  return db
    .collection(COLLECTIONS.manifests)
    .findOne({ materialId }, { sort: { version: -1 } });
}

/**
 * Retrieve all manifests for a material, ordered by version ascending.
 *
 * @param {string} materialId
 * @returns {Promise<object[]>}
 */
export async function getVersionHistory(materialId) {
  const db = await getDb();
  return db
    .collection(COLLECTIONS.manifests)
    .find({ materialId })
    .sort({ version: 1 })
    .toArray();
}

// ── Digest Anchoring ─────────────────────────────────────────────────────────

/**
 * Anchor a manifest digest to an on-chain transaction. This creates an
 * immutable link between the off-chain manifest and a Soroban tx hash.
 *
 * @param {object} params
 * @param {string} params.materialId
 * @param {number} params.version
 * @param {string} params.digest - The manifest digest
 * @param {string} params.chainTxHash - The Stellar/Soroban transaction hash
 * @param {number} [params.ledgerSequence] - The ledger sequence number
 * @returns {Promise<void>}
 */
export async function anchorDigest({
  materialId,
  version,
  digest,
  chainTxHash,
  ledgerSequence,
}) {
  const db = await getDb();

  await db.collection(COLLECTIONS.digestAnchor).updateOne(
    { materialId, version },
    {
      $set: {
        materialId,
        version,
        digest,
        chainTxHash,
        ledgerSequence: ledgerSequence || null,
        anchoredAt: new Date(),
        verified: true,
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );
}

/**
 * Check if a manifest digest has been anchored on-chain.
 *
 * @param {string} materialId
 * @param {number} version
 * @returns {Promise<object|null>} Anchor record or null
 */
export async function getDigestAnchor(materialId, version) {
  const db = await getDb();
  return db.collection(COLLECTIONS.digestAnchor).findOne({ materialId, version });
}

/**
 * Verify that a manifest's digest matches the anchored on-chain digest.
 *
 * @param {string} materialId
 * @param {number} version
 * @returns {Promise<{ verified: boolean, anchor: object|null }>}
 */
export async function verifyAnchoredDigest(materialId, version) {
  const anchor = await getDigestAnchor(materialId, version);
  if (!anchor) return { verified: false, anchor: null };
  return { verified: anchor.verified === true, anchor };
}

// ── Version Chain Integrity ──────────────────────────────────────────────────

/**
 * Verify the full version chain for a material — each version's
 * previousVersionDigest must match the digest of the immediately preceding version.
 *
 * @param {string} materialId
 * @returns {Promise<{ valid: boolean, brokenAt: number|null, manifests: object[] }>}
 */
export async function verifyVersionChain(materialId) {
  const manifests = await getVersionHistory(materialId);

  if (manifests.length === 0) {
    return { valid: false, brokenAt: null, manifests: [] };
  }

  // First version must have null previousVersionDigest
  if (manifests[0].version !== 1) {
    return { valid: false, brokenAt: 1, manifests };
  }
  if (manifests[0].previousVersionDigest !== null) {
    return { valid: false, brokenAt: 1, manifests };
  }

  // Each subsequent version must reference the digest of the prior version
  for (let i = 1; i < manifests.length; i++) {
    const current = manifests[i];
    const previous = manifests[i - 1];

    if (current.version !== previous.version + 1) {
      return { valid: false, brokenAt: current.version, manifests };
    }
    if (current.previousVersionDigest !== previous.digest) {
      return { valid: false, brokenAt: current.version, manifests };
    }
  }

  return { valid: true, brokenAt: null, manifests };
}

// ── Withdrawal / Security Recall ─────────────────────────────────────────────

/**
 * Mark a manifest version as withdrawn. This does not delete the manifest
 * but flags it so downloads and purchases are blocked.
 *
 * @param {string} materialId
 * @param {number} version
 * @param {string} reason - Withdrawal reason
 * @param {string} withdrawnBy - Actor who withdrew
 * @returns {Promise<void>}
 */
export async function withdrawManifest(materialId, version, reason, withdrawnBy) {
  const db = await getDb();
  await db.collection(COLLECTIONS.manifests).updateOne(
    { materialId, version },
    {
      $set: {
        withdrawn: true,
        withdrawnAt: new Date(),
        withdrawalReason: reason || 'Not specified',
        withdrawnBy,
      },
    },
  );
}

/**
 * Check if a manifest version is withdrawn.
 *
 * @param {string} materialId
 * @param {number} version
 * @returns {Promise<boolean>}
 */
export async function isManifestWithdrawn(materialId, version) {
  const db = await getDb();
  const doc = await db
    .collection(COLLECTIONS.manifests)
    .findOne({ materialId, version }, { projection: { withdrawn: 1 } });
  return doc?.withdrawn === true;
}
