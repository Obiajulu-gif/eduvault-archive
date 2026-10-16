# Protected Storage & Content Encryption Specification

## 1. Problem Statement & Threat Model
In standard IPFS pinning setups, files pinned to public IPFS nodes are addressable by their Content Identifier (CID). Knowing the CID is sufficient to fetch the underlying file from any public IPFS gateway (e.g. `https://ipfs.io/ipfs/<CID>`), completely bypassing application-layer entitlement and purchase checks.

## 2. Architecture & Envelope Encryption

To eliminate entitlement bypass:
1. **Never Expose Raw CIDs for Protected Assets**:
   - `sanitizeMaterialPublic` strips `cid`, `ipfsCid`, `fileHash`, and `storageKey` from all public discovery endpoints (`/api/market-materials`, `/api/materials`, `/api/search`) for materials where `price > 0` or `isProtected === true`.
   - Free materials (`price === 0` / `isFree === true`) retain their public CIDs and remain directly fetchable from IPFS gateways without hindrance.

2. **Envelope Encryption (AES-256-GCM)**:
   - When a protected material is uploaded, a cryptographically random 256-bit Content Encryption Key (CEK) is generated.
   - The file contents are encrypted using AES-256-GCM, producing ciphertext and an authentication tag.
   - The CEK is wrapped using the system Master Key (`PROTECTED_STORAGE_MASTER_KEY` / `ENCRYPTION_MASTER_KEY`).
   - The pinned IPFS data is ciphertext: even if an attacker discovers or guesses the CID and fetches it from a public gateway, they obtain only un-decryptable AES ciphertext.

3. **Entitlement-Gated Decryption**:
   - The wrapped CEK is only decrypted and the plaintext content or proxy stream is only released after passing `authorizeMaterialAccess()` (which validates the on-chain / database purchase entitlement).
   - Calls without a valid entitlement return HTTP 401 (unauthenticated) or HTTP 403 (unlicensed).

## 3. Key Management & Rotation
- **Master Key**: Configured via `PROTECTED_STORAGE_MASTER_KEY` (64 hex characters / 256 bits). If not explicitly configured, it is securely derived using HKDF-SHA256 from the application secret.
- **Rotation**: A new master key can be rotated by re-wrapping existing CEKs without requiring re-encryption or re-pinning of the underlying multi-gigabyte IPFS ciphertext.
