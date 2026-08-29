/**
 * Learner Progress & Bookmark Manager (Issue #708).
 *
 * Scopes learning history, progress, and bookmarks strictly by
 * wallet, material ID, and exact purchased material version.
 */

function normalizeWalletAddress(addr) {
  return typeof addr === 'string' ? addr.trim().toUpperCase() : '';
}

/**
 * Creates or updates progress/bookmark state tied to a specific material version.
 */
export async function setLearnerProgress({
  db,
  walletAddress,
  materialId,
  version,
  purchaseId = null,
  bookmarks = [],
  completionPercentage = 0,
  lastPosition = null,
}) {
  const normWallet = normalizeWalletAddress(walletAddress);
  if (!normWallet || !materialId || !version) {
    return { success: false, reason: 'missing_required_scope_fields' };
  }

  const col = db.collection('learner_progress');
  const now = new Date();

  const filter = {
    walletAddress: normWallet,
    materialId: String(materialId),
    version: String(version),
  };

  const update = {
    $set: {
      purchaseId: purchaseId ? String(purchaseId) : null,
      bookmarks: Array.isArray(bookmarks) ? bookmarks : [],
      completionPercentage: Math.max(0, Math.min(100, Number(completionPercentage) || 0)),
      lastPosition: lastPosition || null,
      updatedAt: now,
    },
    $setOnInsert: {
      createdAt: now,
    },
  };

  const options = { upsert: true, returnDocument: 'after' };
  const doc = await col.findOneAndUpdate(filter, update, options);

  return {
    success: true,
    progress: doc || { ...filter, ...update.$set, createdAt: now },
  };
}

/**
 * Retrieves progress/bookmarks for a given wallet, material ID, and version with privacy checks.
 */
export async function getLearnerProgress({
  db,
  walletAddress,
  materialId,
  version,
  requestingActor,
}) {
  const normWallet = normalizeWalletAddress(walletAddress);
  const normActor = normalizeWalletAddress(requestingActor);

  // Privacy Rule: Learner progress can only be read by the wallet owner
  if (normActor && normActor !== normWallet) {
    return { success: false, reason: 'unauthorized_privacy_violation' };
  }

  if (!normWallet || !materialId || !version) {
    return { success: false, reason: 'missing_required_scope_fields' };
  }

  const col = db.collection('learner_progress');
  const record = await col.findOne({
    walletAddress: normWallet,
    materialId: String(materialId),
    version: String(version),
  });

  if (!record) {
    return {
      success: true,
      found: false,
      progress: {
        walletAddress: normWallet,
        materialId: String(materialId),
        version: String(version),
        bookmarks: [],
        completionPercentage: 0,
        lastPosition: null,
      },
    };
  }

  return { success: true, found: true, progress: record };
}

/**
 * Handles material update by initializing/copying progress to the new version
 * while preserving old version bookmarks untouched.
 */
export async function handleMaterialVersionUpdate({
  db,
  walletAddress,
  materialId,
  fromVersion,
  toVersion,
}) {
  const normWallet = normalizeWalletAddress(walletAddress);
  if (!normWallet || !materialId || !fromVersion || !toVersion) {
    return { success: false, reason: 'missing_required_fields' };
  }

  // Read old version progress
  const oldRes = await getLearnerProgress({
    db,
    walletAddress: normWallet,
    materialId,
    version: fromVersion,
    requestingActor: normWallet,
  });

  const oldProgress = oldRes.found ? oldRes.progress : null;

  // Initialize new version progress carrying over bookmarks cleanly without mutating old version
  const newProgress = await setLearnerProgress({
    db,
    walletAddress: normWallet,
    materialId,
    version: toVersion,
    purchaseId: oldProgress?.purchaseId || null,
    bookmarks: oldProgress?.bookmarks ? JSON.parse(JSON.stringify(oldProgress.bookmarks)) : [],
    completionPercentage: oldProgress?.completionPercentage || 0,
    lastPosition: oldProgress?.lastPosition || null,
  });

  return {
    success: true,
    previousVersionProgress: oldProgress,
    newVersionProgress: newProgress.progress,
  };
}

/**
 * Handles material rollback by accessing the target version's historical progress without data loss.
 */
export async function handleMaterialRollback({
  db,
  walletAddress,
  materialId,
  targetVersion,
  requestingActor,
}) {
  return getLearnerProgress({
    db,
    walletAddress,
    materialId,
    version: targetVersion,
    requestingActor,
  });
}

/**
 * Export rules: Exports all version-scoped progress and bookmarks for a learner.
 * Enforces privacy boundary (only owner can export).
 */
export async function exportLearnerProgress({ db, walletAddress, requestingActor }) {
  const normWallet = normalizeWalletAddress(walletAddress);
  const normActor = normalizeWalletAddress(requestingActor);

  if (normActor && normActor !== normWallet) {
    return { success: false, reason: 'unauthorized_privacy_violation' };
  }

  if (!normWallet) {
    return { success: false, reason: 'invalid_wallet_address' };
  }

  const col = db.collection('learner_progress');
  const records = await col.find({ walletAddress: normWallet }).toArray();

  const exportedData = {
    schemaVersion: '1.0.0',
    purpose: 'learner-progress-privacy-export',
    exportedAt: new Date().toISOString(),
    walletAddress: normWallet,
    totalRecords: records.length,
    records: records.map(r => ({
      materialId: r.materialId,
      version: r.version,
      purchaseId: r.purchaseId,
      bookmarks: r.bookmarks || [],
      completionPercentage: r.completionPercentage || 0,
      lastPosition: r.lastPosition || null,
      updatedAt: r.updatedAt,
    })),
  };

  return { success: true, export: exportedData };
}
