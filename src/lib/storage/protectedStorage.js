/**
 * Protected Content Encryption & Storage Security Boundary
 *
 * Implements Issue #751:
 * Prevents entitlement bypass via direct IPFS gateway access to protected files.
 * Uses AES-256-GCM envelope encryption: protected files stored on IPFS are ciphertext.
 * Content Encryption Keys (CEKs) are wrapped with a secure Master Key and strictly gated
 * behind on-chain / database entitlement checks. Raw CIDs for protected materials are
 * NEVER exposed to unauthenticated callers.
 * Free/public materials remain unencrypted and accessible via standard IPFS gateways.
 */

import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const KEY_LENGTH = 32; // 256 bits

/**
 * Resolve or derive the Master Encryption Key.
 */
export function getMasterKey() {
  const envKey = process.env.PROTECTED_STORAGE_MASTER_KEY || process.env.ENCRYPTION_MASTER_KEY;
  if (envKey && /^[0-9a-fA-F]{64}$/.test(envKey)) {
    return Buffer.from(envKey, 'hex');
  }

  // Fallback to HKDF-derived key from JWT_SECRET or seed
  const secret = process.env.JWT_SECRET || 'eduvault-protected-storage-secure-salt';
  return crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.from('eduvault-salt'), Buffer.from('protected-storage-master-key'), KEY_LENGTH);
}

/**
 * Check if a material requires protected storage / entitlement gating.
 */
export function isProtectedMaterial(material) {
  if (!material) return false;
  if (material.isFree === true) return false;
  const price = Number(material.price ?? 0);
  if (price > 0) return true;
  if (material.isProtected === true || material.visibility === 'protected') return true;
  return false;
}

/**
 * Encrypt file buffer for protected IPFS storage using envelope encryption.
 * The returned ciphertext is safe to pin to IPFS publicly because without
 * the entitlement-gated unwrapped CEK, the ciphertext is indecipherable.
 *
 * @param {Buffer|Uint8Array} buffer - Plaintext file content
 * @param {object} [options]
 * @param {Buffer} [options.masterKey] - Optional master key override
 * @returns {object} Encrypted package
 */
export function encryptProtectedContent(buffer, options = {}) {
  const masterKey = options.masterKey || getMasterKey();
  const fileBuf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  // 1. Generate random 256-bit Content Encryption Key (CEK)
  const cek = crypto.randomBytes(KEY_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);

  // 2. Encrypt file with CEK using AES-256-GCM
  const cipher = crypto.createCipheriv(ALGORITHM, cek, iv);
  const ciphertext = Buffer.concat([cipher.update(fileBuf), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // 3. Wrap CEK using Master Key with AES-256-GCM
  const wrapIv = crypto.randomBytes(IV_LENGTH);
  const wrapCipher = crypto.createCipheriv(ALGORITHM, masterKey, wrapIv);
  const wrappedKey = Buffer.concat([wrapCipher.update(cek), wrapCipher.final()]);
  const wrapAuthTag = wrapCipher.getAuthTag();

  return {
    ciphertext,
    algorithm: ALGORITHM,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    wrappedKey: wrappedKey.toString('hex'),
    wrapIv: wrapIv.toString('hex'),
    wrapAuthTag: wrapAuthTag.toString('hex'),
  };
}

/**
 * Decrypt file content using the wrapped key and master key.
 * Gated strictly behind authorizeMaterialAccess.
 *
 * @param {object} payload - Encrypted file payload
 * @param {Buffer} payload.ciphertext - Encrypted bytes
 * @param {string} payload.wrappedKey - Hex-encoded wrapped CEK
 * @param {string} payload.wrapIv - Hex-encoded wrap IV
 * @param {string} payload.wrapAuthTag - Hex-encoded wrap auth tag
 * @param {string} payload.iv - Hex-encoded content IV
 * @param {string} payload.authTag - Hex-encoded content auth tag
 * @param {object} [options]
 * @param {Buffer} [options.masterKey] - Optional master key override
 * @returns {Buffer} Decrypted plaintext file content
 */
export function decryptProtectedContent(payload, options = {}) {
  const masterKey = options.masterKey || getMasterKey();

  // 1. Unwrap CEK using Master Key
  const wrapIv = Buffer.from(payload.wrapIv, 'hex');
  const wrapAuthTag = Buffer.from(payload.wrapAuthTag, 'hex');
  const wrappedKeyBuf = Buffer.from(payload.wrappedKey, 'hex');

  const unwrapCipher = crypto.createDecipheriv(ALGORITHM, masterKey, wrapIv);
  unwrapCipher.setAuthTag(wrapAuthTag);
  const cek = Buffer.concat([unwrapCipher.update(wrappedKeyBuf), unwrapCipher.final()]);

  // 2. Decrypt content with unwrapped CEK
  const iv = Buffer.from(payload.iv, 'hex');
  const authTag = Buffer.from(payload.authTag, 'hex');
  const ciphertext = Buffer.isBuffer(payload.ciphertext) ? payload.ciphertext : Buffer.from(payload.ciphertext);

  const decipher = crypto.createDecipheriv(ALGORITHM, cek, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return plaintext;
}

/**
 * Sanitize material document before returning to public/unauthenticated endpoints.
 * Never exposes raw CIDs, storageKeys, or encryption secrets of protected materials.
 * Free materials remain untouched so existing public workflows continue working.
 */
export function sanitizeMaterialPublic(doc) {
  if (!doc) return doc;

  const isProtected = isProtectedMaterial(doc);
  const { storageKey, fileUrl, metadataUrl, wrappedKey, wrapIv, wrapAuthTag, authTag, iv, ...safe } = doc;

  if (isProtected) {
    // Strip raw CIDs and file locations for protected files
    delete safe.cid;
    delete safe.ipfsCid;
    delete safe.fileHash;

    return {
      ...safe,
      isProtected: true,
      requiresEntitlement: true,
      deliveryEndpoint: `/api/materials/deliver/${doc._id}`,
    };
  }

  // Free/public materials retain their public IPFS CID
  return {
    ...safe,
    isProtected: false,
    requiresEntitlement: false,
  };
}
