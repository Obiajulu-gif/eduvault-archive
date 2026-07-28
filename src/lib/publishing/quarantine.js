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

/**
 * Create a quarantine record for an uploaded file/content.
 */
export async function createQuarantineRecord({
  db,
  contentHash,
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
    fileName,
    mimeType,
    sizeBytes,
    uploaderAddress: uploaderAddress.toLowerCase(),
    materialId: materialId || null,
    state: QUARANTINE_STATES.PENDING,
    reason: null,
    scanner: null,
    scanResult: null,
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

  const result = await collection.findOneAndUpdate(
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

  return result.value;
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
  scannerImpl,
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
  const scanPromise = (async () => {
    try {
      const scanOutput = await scannerImpl.scan({
        contentHash,
        fileName,
        mimeType,
        sizeBytes,
      });
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
          scanResult: { verdict: 'review', notes: scanOutput.notes || null },
        });
      }

      return finalizeQuarantine({
        db,
        contentHash,
        state: QUARANTINE_STATES.CLEAN,
        scanner: scanOutput.scannerName || scannerImpl.name,
        scanResult: { verdict: 'clean', engineVersion: scanOutput.engineVersion || null },
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
 */
export async function verifyMaterialNotQuarantined(db, contentHash) {
  const decision = await getQuarantineDecision(db, contentHash);
  if (!decision) {
    // Pending scans block publication.
    return { allowed: false, state: QUARANTINE_STATES.PENDING, reason: 'Scan pending' };
  }
  if (decision.state !== QUARANTINE_STATES.CLEAN) {
    return { allowed: false, state: decision.state, reason: decision.reason };
  }
  return { allowed: true, state: decision.state };
}

/**
 * Replay quarantined items after scanner outage recovery.
 */
export async function replayQuarantine(db, limit = 100) {
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
    results.push(doc.contentHash);
  }

  return results;
}