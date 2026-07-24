import { getDb } from '@/lib/mongodb';
import { verifyFileBytes, verifyManifestDigest } from './manifest';
import { getManifest, isManifestWithdrawn, getLatestManifest } from './registry';

export { verifyManifestDigest };

/**
 * Download verification — ensures file bytes match the purchased manifest
 * before reporting download success. Supports both CID-based IPFS verification
 * and direct byte-hash verification.
 */

// ── Verification Errors ──────────────────────────────────────────────────────

export const VERIFY_STATUS = Object.freeze({
  OK: 'verified',
  MISMATCH: 'hash_mismatch',
  MISSING_MANIFEST: 'manifest_not_found',
  WITHDRAWN: 'version_withdrawn',
  MISSING_PURCHASE: 'purchase_not_found',
  NO_PURCHASE_VERSION: 'no_version_binding',
  STALE_VERSION: 'stale_version',
  ERROR: 'verification_error',
});

// ── Core Verification ────────────────────────────────────────────────────────

/**
 * Verify that a download is legitimate by checking:
 * 1. The buyer has a purchase for this material
 * 2. The purchase is bound to a specific manifest version
 * 3. The manifest exists and is not withdrawn
 * 4. The manifest digest matches what was anchored (if anchored)
 * 5. Optionally, the provided file bytes match the manifest's file hash
 *
 * @param {object} params
 * @param {string} params.materialId
 * @param {number} params.version - The version the buyer is attempting to download
 * @param {string} params.buyerAddress - The buyer's wallet address
 * @param {Buffer|Uint8Array} [params.fileBytes] - Optional raw file bytes for byte-level verification
 * @returns {Promise<{ status: string, manifest: object|null, purchase: object|null, detail: string }>}
 */
export async function verifyDownload({
  materialId,
  version,
  buyerAddress,
  fileBytes,
}) {
  const db = await getDb();

  // 1. Check purchase exists
  const purchase = await db.collection('purchases').findOne({
    materialId,
    buyerAddress: buyerAddress.toLowerCase(),
  });

  if (!purchase) {
    return {
      status: VERIFY_STATUS.MISSING_PURCHASE,
      manifest: null,
      purchase: null,
      detail: 'No purchase record found for this buyer and material',
    };
  }

  const completedStatuses = ['confirmed', 'settled', 'completed'];
  if (!completedStatuses.includes(String(purchase.status || '').toLowerCase())) {
    return {
      status: VERIFY_STATUS.MISSING_PURCHASE,
      manifest: null,
      purchase,
      detail: `Purchase status "${purchase.status}" does not grant download access`,
    };
  }

  // 2. Check version binding on the purchase
  const purchaseVersion = purchase.purchasedVersion
    || purchase.versionBinding?.version
    || null;

  if (purchaseVersion != null && purchaseVersion !== version) {
    return {
      status: VERIFY_STATUS.STALE_VERSION,
      manifest: null,
      purchase,
      detail: `Purchase is bound to version ${purchaseVersion}, but version ${version} was requested`,
    };
  }

  // 3. Check manifest exists and is not withdrawn
  const manifestDoc = await getManifest(materialId, version);
  if (!manifestDoc) {
    return {
      status: VERIFY_STATUS.MISSING_MANIFEST,
      manifest: null,
      purchase,
      detail: `No manifest found for material ${materialId} version ${version}`,
    };
  }

  if (manifestDoc.withdrawn) {
    return {
      status: VERIFY_STATUS.WITHDRAWN,
      manifest: manifestDoc.manifest,
      purchase,
      detail: `Version ${version} has been withdrawn: ${manifestDoc.withdrawalReason || 'No reason specified'}`,
    };
  }

  // 4. Verify manifest digest integrity
  const digestValid = verifyManifestDigest(manifestDoc.manifest, manifestDoc.digest);
  if (!digestValid) {
    return {
      status: VERIFY_STATUS.MISMATCH,
      manifest: manifestDoc.manifest,
      purchase,
      detail: 'Manifest digest does not match stored digest — manifest may have been tampered with',
    };
  }

  // 5. Verify file bytes against manifest (if provided)
  if (fileBytes) {
    const fileHash = manifestDoc.manifest?.file?.hash;
    if (fileHash) {
      const bytesMatch = verifyFileBytes(fileBytes, fileHash);
      if (!bytesMatch) {
        return {
          status: VERIFY_STATUS.MISMATCH,
          manifest: manifestDoc.manifest,
          purchase,
          detail: 'Downloaded file bytes do not match the manifest hash',
        };
      }
    }
  }

  return {
    status: VERIFY_STATUS.OK,
    manifest: manifestDoc.manifest,
    purchase,
    detail: 'Download verified successfully',
  };
}

/**
 * Verify that a file CID matches the CID recorded in the manifest for a given version.
 * Used when the file is served via IPFS and we can check the CID.
 *
 * @param {string} materialId
 * @param {number} version
 * @param {string} providedCid - The CID being served
 * @returns {Promise<{ valid: boolean, manifestCid: string|null, detail: string }>}
 */
export async function verifyFileCid(materialId, version, providedCid) {
  const manifestDoc = await getManifest(materialId, version);
  if (!manifestDoc) {
    return { valid: false, manifestCid: null, detail: 'Manifest not found' };
  }

  const manifestCid = manifestDoc.manifest?.file?.cid;
  if (!manifestCid) {
    return { valid: false, manifestCid: null, detail: 'No CID in manifest' };
  }

  const valid = manifestCid === providedCid;
  return {
    valid,
    manifestCid,
    detail: valid ? 'CID matches' : `CID mismatch: expected ${manifestCid}, got ${providedCid}`,
  };
}

/**
 * Get the latest verified manifest for a material. Used by the download
 * route to resolve which version to serve when no explicit version is requested.
 *
 * @param {string} materialId
 * @returns {Promise<{ manifest: object|null, digest: string|null, withdrawn: boolean }>}
 */
export async function getLatestVerifiedManifest(materialId) {
  const manifestDoc = await getLatestManifest(materialId);
  if (!manifestDoc) {
    return { manifest: null, digest: null, withdrawn: false };
  }

  const digestValid = verifyManifestDigest(manifestDoc.manifest, manifestDoc.digest);

  return {
    manifest: manifestDoc.manifest,
    digest: manifestDoc.digest,
    withdrawn: manifestDoc.withdrawn === true,
    digestValid,
  };
}
