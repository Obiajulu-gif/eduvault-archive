import {
  hashManifest,
  verifyManifestAttestation,
} from '@/lib/backend/contentManifest';

/**
 * Trace a registry/on-chain content binding hash back to stored scan evidence.
 */
export async function verifyContentBindingTrace(db, { contentHash, expectedManifestHash }) {
  const manifests = await db
    .collection('content_manifests')
    .find({ contentHash })
    .sort({ generation: -1 })
    .toArray();

  if (manifests.length === 0) {
    return { verified: false, reason: 'No manifest history found' };
  }

  const quarantine = await db.collection('quarantine').findOne({ contentHash });
  const match = manifests.find((entry) => entry.manifestHash === expectedManifestHash) || manifests[0];
  const recomputed = hashManifest(match.manifest);

  if (recomputed !== match.manifestHash) {
    return { verified: false, reason: 'Manifest hash does not match stored record' };
  }

  const secret = process.env.CONTENT_MANIFEST_SECRET || process.env.JWT_SECRET;
  const attestationValid = secret
    ? verifyManifestAttestation(match.manifest, match.attestation, secret)
    : false;

  return {
    verified: recomputed === expectedManifestHash && attestationValid,
    manifest: match.manifest,
    manifestHash: match.manifestHash,
    generation: match.generation,
    quarantineState: quarantine?.state || null,
    scanResult: quarantine?.scanResult || null,
  };
}
