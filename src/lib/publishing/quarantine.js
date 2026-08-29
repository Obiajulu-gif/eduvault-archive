/**
 * Asynchronous quarantine pipeline for material publication.
 * 
 * State machine:
 *   pending -> clean | rejected | manual_review | timeout | scanner_unavailable
 * 
 * Consumers (listing/publishing/delivery) must verify the material is not quarantined.
 */

export const QUARANTINE_STATES = {
  PENDING: 'pending',
  CLEAN: 'clean',
  REJECTED: 'rejected',
  MANUAL_REVIEW: 'manual_review',
  TIMEOUT: 'timeout',
  SCANNER_UNAVAILABLE: 'scanner_unavailable',
};

export const QUARANTINE_REASONS = {
  MALWARE_SIGNATURE: 'malware_signature',
  MIME_MISMATCH: 'mime_mismatch',
  POLYGLOT_DETECTED: 'polyglot_detected',
  ARCHIVE_RISK: 'archive_risk',
  MACRO_DETECTED: 'macro_detected',
  SCANNER_TIMEOUT: 'scanner_timeout',
  SCANNER_OUTAGE: 'scanner_outage',
  MANUAL_REVIEW_REQUIRED: 'manual_review_required',
};

const DEFAULT_CONFIG = {
  scanTimeoutMs: 30_000,
  quarantineTtlMs: 24 * 60 * 60 * 1000, // 24 hours
  maxRetries: 3,
};

function buildIpfsGatewayUrl(contentHash) {
  const gateway = process.env.NEXT_PUBLIC_GATEWAY_URL || process.env.IPFS_GATEWAY_URL || 'https://gateway.pinata.cloud';
  return `${gateway.replace(/\/$/, '')}/ipfs/${encodeURIComponent(contentHash)}`;
}

export function createIpfsFetchScanner({ fetchImpl = globalThis.fetch } = {}) {
  return {
    name: 'ipfs-fetch-scanner',
    async scan({ contentHash }) {
      if (typeof fetchImpl !== 'function') {
        throw new Error('No fetch implementation available for IPFS scan');
      }

      const response = await fetchImpl(buildIpfsGatewayUrl(contentHash), {
        signal: AbortSignal.timeout(DEFAULT_CONFIG.scanTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Unable to fetch quarantined content: ${response.status}`);
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      const sample = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 4096)));
      const infected = sample.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE');

      return infected
        ? {
            infected: true,
            reason: QUARANTINE_REASONS.MALWARE_SIGNATURE,
            threats: ['EICAR-Test-File'],
          }
        : { infected: false };
    },
  };
}

import {
  attestManifest,
  buildContentManifest,
  getManifestSecret,
} from '@/lib/backend/contentManifest';

/**
 * Persist an append-only manifest generation after a clean scan.
 */
export async function recordContentManifest({
  db,
  contentHash,
  byteHash,
  mimeType,
  sizeBytes,
  uploaderAddress,
  scanner,
  scanResult = null,
}) {
  const manifests = db.collection('content_manifests');
  const latest = await manifests.findOne({ contentHash }, { sort: { generation: -1 } });
  const generation = (latest?.generation || 0) + 1;
  const manifest = buildContentManifest({
    byteHash,
    sizeBytes,
    mediaType: mimeType,
    cid: contentHash,
    creator: uploaderAddress,
    scanner,
    scannerVersion: scanResult?.engineVersion || null,
    generation,
  });

  const secret = getManifestSecret();
  const { manifestHash, attestation } = secret
    ? attestManifest(manifest, secret)
    : { manifestHash: null, attestation: null };

  const now = new Date();
  await manifests.insertOne({
    contentHash,
    generation,
    manifest,
    manifestHash,
    attestation,
    createdAt: now,
  });

  await db.collection('quarantine').updateOne(
    { contentHash },
    {
      $set: {
        byteHash,
        manifestHash,
        manifestGeneration: generation,
        updatedAt: now,
      },
    }
  );

  return { manifest, manifestHash, generation, attestation };
}

/**
 * Create a quarantine record for an uploaded file/content.
 */
export async function createQuarantineRecord({
  db,
  contentHash,
  byteHash = null,
  fileName,
  mimeType,
  sizeBytes,
  uploaderAddress,
  materialId = null,
  config = DEFAULT_CONFIG,
}) {
  const collection = db.collection('quarantine');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.quarantineTtlMs);

  const record = {
    contentHash,
    byteHash,
    fileName,
    mimeType,
    sizeBytes,
    uploaderAddress: uploaderAddress.toLowerCase(),
    materialId: materialId || null,
    state: QUARANTINE_STATES.PENDING,
    reason: null,
    scanner: null,
    scanResult: null,
    manifestHash: null,
    manifestGeneration: null,
    attemptCount: 0,
    lastAttemptAt: null,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };

  await collection.createIndex({ contentHash: 1 }, { unique: true, background: true });
  await collection.createIndex({ state: 1, createdAt: 1 }, { background: true });
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, background: true });

  await collection.insertOne(record);
  return record;
}

/**
 * Update quarantine state with scan result.
 * State transitions:
 *   pending -> clean | rejected | manual_review | timeout | scanner_unavailable
 * Once finalized, further updates are ignored.
 */
export async function finalizeQuarantine({
  db,
  contentHash,
  state,
  reason = null,
  scanner = 'default',
  scanResult = null,
}) {
  if (!Object.values(QUARANTINE_STATES).includes(state)) {
    throw new Error(`Invalid quarantine state: ${state}`);
  }

  const collection = db.collection('quarantine');
  const now = new Date();

  // MongoDB Node driver v6 (installed here: 6.21.0) returns the matched
  // document directly from findOneAndUpdate, not wrapped in `{ value }`
  // (that was the v4/v5 shape). Reading `.value` made this always return
  // undefined — silently breaking every caller downstream, notably
  // runScanner's `if (finalized?.byteHash)` manifest-recording branch,
  // which never actually fired.
  return collection.findOneAndUpdate(
    { contentHash, state: QUARANTINE_STATES.PENDING },
    {
      $set: {
        state,
        reason,
        scanner,
        scanResult,
        lastAttemptAt: now,
        updatedAt: now,
      },
      $inc: { attemptCount: 1 },
    },
    { returnDocument: 'after' }
  );
}

/**
 * Execute the pluggable malware scanner against a content hash.
 */
export async function runScanner({
  db,
  contentHash,
  fileName,
  mimeType,
  sizeBytes,
  scannerImpl = createIpfsFetchScanner(),
  timeoutMs = DEFAULT_CONFIG.scanTimeoutMs,
}) {
  const quarantine = await db.collection('quarantine').findOne({ contentHash });
  if (!quarantine) {
    throw new Error('No quarantine record found');
  }
  if (quarantine.state !== QUARANTINE_STATES.PENDING) {
    return quarantine;
  }

  // Initialise a timeout controller for the scan.
  let scanCompleted = false;
  const scanStartedAt = new Date();
  const scanPromise = (async () => {
    try {
      const scanOutput = await scannerImpl.scan({
        contentHash,
        fileName,
        mimeType,
        sizeBytes,
      });
      // Provenance (issue #637): signature version distinct from engine
      // version (some engines version their signature DB independently of
      // the engine binary), plus explicit scan timing.
      const provenance = {
        artifactHash: contentHash,
        signatureVersion: scanOutput.signatureVersion || scannerImpl.signatureVersion || null,
        scanStartedAt,
        scanCompletedAt: new Date(),
        scanDurationMs:
          typeof scanOutput.scanDurationMs === 'number'
            ? scanOutput.scanDurationMs
            : Date.now() - scanStartedAt.getTime(),
      };

      if (scanOutput.infected) {
        return finalizeQuarantine({
          db,
          contentHash,
          state: QUARANTINE_STATES.REJECTED,
          reason: scanOutput.reason || QUARANTINE_REASONS.MALWARE_SIGNATURE,
          scanner: scanOutput.scannerName || scannerImpl.name,
          scanResult: {
            verdict: 'infected',
            threats: scanOutput.threats || [],
            engineVersion: scanOutput.engineVersion || null,
            ...provenance,
          },
        });
      }

      if (scanOutput.requiresManualReview) {
        return finalizeQuarantine({
          db,
          contentHash,
          state: QUARANTINE_STATES.MANUAL_REVIEW,
          reason: QUARANTINE_REASONS.MANUAL_REVIEW_REQUIRED,
          scanner: scanOutput.scannerName || scannerImpl.name,
          scanResult: { verdict: 'review', notes: scanOutput.notes || null, ...provenance },
        });
      }

      // Indeterminate (issue #637): the scan RAN to completion but the
      // engine couldn't reach a clean/infected verdict — distinct from a
      // crash/outage (the `catch` block below), which never got a verdict
      // at all. Both currently route to SCANNER_UNAVAILABLE/manual review
      // territory, but are recorded with a distinguishable reason so an
      // operator can tell "the scanner is broken" from "the scanner
      // genuinely doesn't know" — fails closed either way (blocks publish).
      if (scanOutput.indeterminate) {
        return finalizeQuarantine({
          db,
          contentHash,
          state: QUARANTINE_STATES.MANUAL_REVIEW,
          reason: QUARANTINE_REASONS.MANUAL_REVIEW_REQUIRED,
          scanner: scanOutput.scannerName || scannerImpl.name,
          scanResult: { verdict: 'indeterminate', notes: scanOutput.notes || null, ...provenance },
        });
      }

      const finalized = await finalizeQuarantine({
        db,
        contentHash,
        state: QUARANTINE_STATES.CLEAN,
        scanner: scanOutput.scannerName || scannerImpl.name,
        scanResult: { verdict: 'clean', engineVersion: scanOutput.engineVersion || null, ...provenance },
      });

      if (finalized?.byteHash) {
        await recordContentManifest({
          db,
          contentHash,
          byteHash: finalized.byteHash,
          mimeType,
          sizeBytes,
          uploaderAddress: quarantine.uploaderAddress,
          scanner: scanOutput.scannerName || scannerImpl.name,
          scanResult: { engineVersion: scanOutput.engineVersion || null },
        });
      }

      return finalized;
    } catch (error) {
      return finalizeQuarantine({
        db,
        contentHash,
        state: QUARANTINE_STATES.SCANNER_UNAVAILABLE,
        reason: QUARANTINE_REASONS.SCANNER_OUTAGE,
        scanner: scannerImpl.name || 'default',
        scanResult: { verdict: 'error', message: error?.message || String(error) },
      });
    } finally {
      scanCompleted = true;
    }
  })();

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      if (!scanCompleted) {
        resolve(
          finalizeQuarantine({
            db,
            contentHash,
            state: QUARANTINE_STATES.SCANNER_UNAVAILABLE,
            reason: QUARANTINE_REASONS.SCANNER_TIMEOUT,
          })
        );
      }
    }, timeoutMs);
  });

  return Promise.race([scanPromise, timeoutPromise]);
}

/**
 * Get final quarantine decision for a content hash.
 * Returns null if still pending.
 */
export async function getQuarantineDecision(db, contentHash) {
  const record = await db.collection('quarantine').findOne({ contentHash });
  if (!record || record.state === QUARANTINE_STATES.PENDING) return null;
  return record;
}

/**
 * Verify a material is not quarantined.
 *
 * Staleness (issue #637): a `clean` verdict recorded against a since-
 * superseded signature version is NOT treated as permanently valid — an
 * engine update can turn a previously-clean file into a known threat, so a
 * stale `clean` blocks publish the same as `pending`, until it's rescanned.
 * `currentSignatureVersion` is optional so existing callers that don't (yet)
 * pass one keep the pre-#637 behavior unchanged.
 */
export async function verifyMaterialNotQuarantined(db, contentHash, { currentSignatureVersion = null } = {}) {
  const decision = await getQuarantineDecision(db, contentHash);
  if (!decision) {
    // Pending scans block publication.
    return { allowed: false, state: QUARANTINE_STATES.PENDING, reason: 'Scan pending' };
  }
  if (decision.state !== QUARANTINE_STATES.CLEAN) {
    return { allowed: false, state: decision.state, reason: decision.reason };
  }

  const recordedVersion = decision.scanResult?.signatureVersion;
  if (currentSignatureVersion && recordedVersion && recordedVersion !== currentSignatureVersion) {
    return {
      allowed: false,
      state: QUARANTINE_STATES.PENDING,
      reason: `Stale scan: signature version ${recordedVersion} superseded by ${currentSignatureVersion}`,
      stale: true,
    };
  }

  return { allowed: true, state: decision.state };
}

/**
 * Replay quarantined items after scanner outage recovery.
 */
export async function replayQuarantine(db, limit = 100, { scannerImpl, timeoutMs } = {}) {
  const collection = db.collection('quarantine');
  const cursor = collection
    .find({
      state: { $in: [QUARANTINE_STATES.TIMEOUT, QUARANTINE_STATES.SCANNER_UNAVAILABLE] },
    })
    .limit(limit);

  const results = [];
  for await (const doc of cursor) {
    await collection.updateOne(
      { _id: doc._id },
      {
        $set: {
          state: QUARANTINE_STATES.PENDING,
          reason: null,
          updatedAt: new Date(),
        },
      }
    );
    await runScanner({
      db,
      contentHash: doc.contentHash,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      scannerImpl,
      timeoutMs,
    });
    results.push(doc.contentHash);
  }

  return results;
}

/**
 * Rescans previously-`clean` items whose recorded signature version is
 * behind `currentSignatureVersion` (issue #637: "engine updates trigger
 * bounded, resumable rescan policy"). Bounded by `limit` per invocation —
 * this is meant to be called repeatedly (e.g. from a cron job) rather than
 * rescanning everything in one pass, so a large backlog doesn't overload
 * the scanner in a single run. `cursorContentHash` lets a caller resume a
 * batch where the previous invocation left off, ordered by contentHash for
 * a stable, resumable cursor.
 */
export async function rescanStaleClean(db, {
  currentSignatureVersion,
  limit = 100,
  cursorContentHash = null,
  scannerImpl,
  timeoutMs,
} = {}) {
  if (!currentSignatureVersion) {
    throw new Error('rescanStaleClean requires currentSignatureVersion');
  }

  const collection = db.collection('quarantine');
  const query = {
    state: QUARANTINE_STATES.CLEAN,
    $or: [
      { 'scanResult.signatureVersion': { $exists: false } },
      { 'scanResult.signatureVersion': null },
      { 'scanResult.signatureVersion': { $ne: currentSignatureVersion } },
    ],
    ...(cursorContentHash ? { contentHash: { $gt: cursorContentHash } } : {}),
  };

  const cursor = collection.find(query).sort({ contentHash: 1 }).limit(limit);

  const results = [];
  for await (const doc of cursor) {
    await collection.updateOne(
      { _id: doc._id },
      {
        $set: {
          state: QUARANTINE_STATES.PENDING,
          reason: null,
          updatedAt: new Date(),
        },
      }
    );
    await runScanner({
      db,
      contentHash: doc.contentHash,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      scannerImpl,
      timeoutMs,
    });
    results.push(doc.contentHash);
  }

  return {
    rescanned: results,
    // A caller resumes the next batch by passing this back in as
    // cursorContentHash — null means the backlog for this signature
    // version is exhausted.
    nextCursor: results.length === limit ? results[results.length - 1] : null,
  };
}
