import crypto from "node:crypto";
import { AppError } from "../errors/AppError.js";
import { CheckStatus, checkDeploymentAuthorization } from "../release/releaseReadiness.js";

/**
 * Versioned Material Metadata Migration Engine with Rollback.
 *
 * Provides safe, auditable, multi-step migrations for material metadata
 * (`metadataVersion` + `metadata.*`) while preserving all existing catalog
 * contracts (`schemaVersion`, top-level fields, Soroban entitlement fields).
 *
 * Guarantees:
 * - Pre-flight operator authorization on every mutating and recovery path.
 * - Per-document pre-migration snapshots for lossless rollback.
 * - Bounded exponential retry for transient storage failures.
 * - Automatic rollback on failure (configurable) and resumable operator retry.
 * - Drift / concurrent-edit detection on rollback unless `force: true`.
 */

export const METADATA_MIGRATION_RUNS_COLLECTION = "material_metadata_migration_runs";
export const METADATA_MIGRATION_SNAPSHOTS_COLLECTION = "material_metadata_migration_snapshots";

export const MIN_METADATA_VERSION = 1;
export const CURRENT_METADATA_VERSION = 3;

export const MetadataMigrationState = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  ROLLING_BACK: "rolling_back",
  ROLLED_BACK: "rolled_back",
  PARTIALLY_ROLLED_BACK: "partially_rolled_back",
  ROLLBACK_FAILED: "rollback_failed",
});

export const ACTIVE_RUN_STATES = Object.freeze([
  MetadataMigrationState.RUNNING,
  MetadataMigrationState.ROLLING_BACK,
]);

export const UNRESOLVED_RUN_STATES = Object.freeze([
  MetadataMigrationState.FAILED,
  MetadataMigrationState.ROLLBACK_FAILED,
  MetadataMigrationState.PARTIALLY_ROLLED_BACK,
]);

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 25;
const MAX_ERROR_MESSAGE_LENGTH = 500;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stableSerialize(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value.toHexString === "function") return JSON.stringify(value.toHexString());
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
    .join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function formatErrorMessage(error) {
  return String(error?.message ?? error).slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function normalizeTags(rawTags) {
  const list = Array.isArray(rawTags)
    ? rawTags
    : typeof rawTags === "string"
      ? rawTags.split(",")
      : [];
  const seen = new Set();
  const normalized = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const cleaned = item.trim().toLowerCase();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    normalized.push(cleaned);
  }
  return normalized;
}

function computeMetadataChecksum(metadata) {
  if (!metadata || typeof metadata !== "object") return sha256({});
  const { checksum: _ignored, migratedAt: _ignoredAt, ...rest } = metadata;
  return sha256(rest);
}

/**
 * Default versioned metadata migration registry.
 *
 * Each step N transforms a material document from metadataVersion N-1 -> N
 * (up) and N -> N-1 (down), and validates the resulting vN document.
 * All steps are additive with respect to legacy top-level fields so existing
 * API and catalog contracts remain intact.
 */
export const DEFAULT_METADATA_MIGRATIONS = Object.freeze({
  2: Object.freeze({
    version: 2,
    name: "v2_normalized_taxonomy_and_tags",
    up(doc) {
      const existingMeta =
        doc.metadata && typeof doc.metadata === "object" ? { ...doc.metadata } : {};
      const normalizedTags = normalizeTags(existingMeta.tags ?? doc.tags);
      const language =
        typeof (existingMeta.language ?? doc.language) === "string" &&
        String(existingMeta.language ?? doc.language).trim()
          ? String(existingMeta.language ?? doc.language).trim().toLowerCase()
          : "en";

      return {
        ...doc,
        metadataVersion: 2,
        metadata: {
          ...existingMeta,
          tags: normalizedTags,
          language,
          taxonomy: {
            category: existingMeta.taxonomy?.category ?? doc.category ?? "general",
            subject: existingMeta.taxonomy?.subject ?? doc.subject ?? null,
            level: existingMeta.taxonomy?.level ?? doc.level ?? "all",
          },
        },
      };
    },
    down(doc) {
      const copy = { ...doc };
      if (copy.metadata && typeof copy.metadata === "object") {
        const metaCopy = { ...copy.metadata };
        delete metaCopy.taxonomy;
        delete metaCopy.tags;
        delete metaCopy.language;
        if (Object.keys(metaCopy).length === 0) {
          delete copy.metadata;
        } else {
          copy.metadata = metaCopy;
        }
      }
      copy.metadataVersion = 1;
      return copy;
    },
    validate(doc) {
      return Boolean(
        doc &&
          doc.metadataVersion === 2 &&
          doc.metadata &&
          typeof doc.metadata === "object" &&
          Array.isArray(doc.metadata.tags) &&
          typeof doc.metadata.language === "string" &&
          doc.metadata.language.length > 0 &&
          doc.metadata.taxonomy &&
          typeof doc.metadata.taxonomy.category === "string"
      );
    },
  }),
  3: Object.freeze({
    version: 3,
    name: "v3_structured_licensing_and_checksum",
    up(doc) {
      const existingMeta =
        doc.metadata && typeof doc.metadata === "object" ? { ...doc.metadata } : {};
      const rights = doc.rightsMetadata && typeof doc.rightsMetadata === "object" ? doc.rightsMetadata : {};
      const licensing = {
        licenseType:
          existingMeta.licensing?.licenseType ??
          doc.license ??
          (rights.commercialUse ? "commercial" : "educational"),
        attributionRequired: existingMeta.licensing?.attributionRequired ?? true,
        commercialAllowed: existingMeta.licensing?.commercialAllowed ?? Boolean(rights.commercialUse),
        distributionAllowed: existingMeta.licensing?.distributionAllowed ?? Boolean(rights.distributionAllowed),
      };

      const nextMeta = {
        ...existingMeta,
        licensing,
      };
      nextMeta.checksum = computeMetadataChecksum(nextMeta);

      return {
        ...doc,
        metadataVersion: 3,
        metadata: nextMeta,
      };
    },
    down(doc) {
      const copy = { ...doc };
      if (copy.metadata && typeof copy.metadata === "object") {
        const metaCopy = { ...copy.metadata };
        delete metaCopy.licensing;
        delete metaCopy.checksum;
        copy.metadata = metaCopy;
      }
      copy.metadataVersion = 2;
      return copy;
    },
    validate(doc) {
      return Boolean(
        doc &&
          doc.metadataVersion === 3 &&
          doc.metadata &&
          typeof doc.metadata === "object" &&
          doc.metadata.licensing &&
          typeof doc.metadata.licensing.licenseType === "string" &&
          typeof doc.metadata.licensing.attributionRequired === "boolean" &&
          typeof doc.metadata.checksum === "string" &&
          doc.metadata.checksum.length === 64
      );
    },
  }),
});

function getLatestVersion(registry) {
  const versions = Object.keys(registry)
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n) && n >= MIN_METADATA_VERSION);
  return versions.length > 0 ? Math.max(...versions) : MIN_METADATA_VERSION;
}

function getEffectiveMetadataVersion(doc) {
  const raw = doc?.metadataVersion;
  if (raw === undefined || raw === null) return MIN_METADATA_VERSION;
  return raw;
}

function assertValidTargetVersion(targetVersion, registry) {
  const latest = getLatestVersion(registry);
  if (!Number.isInteger(targetVersion) || targetVersion < MIN_METADATA_VERSION || targetVersion > latest) {
    throw new AppError("VALIDATION_FIELD", {
      message: `Unsupported target metadataVersion ${JSON.stringify(targetVersion)} (supported: ${MIN_METADATA_VERSION}-${latest}).`,
      details: { field: "targetVersion", min: MIN_METADATA_VERSION, latest },
    });
  }
}

/**
 * Validates that the caller is authorized to run, retry, or roll back
 * material metadata migrations.
 */
export function assertMetadataMigrationAuthorized(actor) {
  const check = checkDeploymentAuthorization(actor);
  if (check.status !== CheckStatus.PASSED) {
    throw new AppError("AUTH_FORBIDDEN", {
      message: check.message || "Actor is not authorized for material metadata migrations.",
      details: { reason: "metadata_migration_unauthorized", actorId: actor?.id ?? null },
    });
  }
}

async function withRetry(fn, { maxRetries = DEFAULT_MAX_RETRIES, retryDelayMs = DEFAULT_RETRY_DELAY_MS, sleep = defaultSleep } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || error?.retryable === false) {
        throw error;
      }
      await sleep(retryDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

/**
 * Non-mutating dual-read helper that projects a material document to the
 * requested `targetVersion` in memory without modifying the stored record.
 */
export function readMaterialMetadata(
  doc,
  { targetVersion, registry = DEFAULT_METADATA_MIGRATIONS } = {}
) {
  if (!doc || typeof doc !== "object") return doc;
  const latest = getLatestVersion(registry);
  const resolvedTarget = targetVersion ?? latest;
  assertValidTargetVersion(resolvedTarget, registry);

  const currentVersion = getEffectiveMetadataVersion(doc);
  if (!Number.isInteger(currentVersion) || currentVersion < MIN_METADATA_VERSION || currentVersion > latest) {
    throw new AppError("VALIDATION_FIELD", {
      message: `Material has unsupported metadataVersion ${JSON.stringify(currentVersion)} (supported: ${MIN_METADATA_VERSION}-${latest}).`,
      details: { field: "metadataVersion", currentVersion, min: MIN_METADATA_VERSION, latest },
    });
  }

  let current = structuredClone(doc);
  if (resolvedTarget > currentVersion) {
    for (let v = currentVersion + 1; v <= resolvedTarget; v += 1) {
      const step = registry[v];
      if (!step || typeof step.up !== "function") {
        throw new AppError("VALIDATION_FIELD", {
          message: `Missing forward metadata migration step for v${v}.`,
          details: { version: v },
        });
      }
      current = step.up(current);
    }
  } else if (resolvedTarget < currentVersion) {
    for (let v = currentVersion; v > resolvedTarget; v -= 1) {
      const step = registry[v];
      if (!step || typeof step.down !== "function") {
        throw new AppError("VALIDATION_FIELD", {
          message: `Missing rollback metadata migration step for v${v}.`,
          details: { version: v },
        });
      }
      current = step.down(current);
    }
  }

  return current;
}

function applyForwardSteps(doc, fromVersion, targetVersion, registry) {
  let current = structuredClone(doc);
  for (let v = fromVersion + 1; v <= targetVersion; v += 1) {
    const step = registry[v];
    if (!step || typeof step.up !== "function") {
      throw new AppError("VALIDATION_FAILED", {
        message: `Missing forward migration step for metadataVersion v${v}.`,
        details: { version: v },
      });
    }
    current = step.up(current);
    if (typeof step.validate === "function" && !step.validate(current)) {
      const validationErr = new AppError("VALIDATION_FAILED", {
        message: `Document ${String(doc._id)} failed validation for metadataVersion v${v}.`,
        details: { materialId: String(doc._id), version: v },
      });
      validationErr.retryable = false;
      throw validationErr;
    }
  }
  return current;
}

function capturePreMigrationFields(doc) {
  return {
    hadMetadataVersion: Object.prototype.hasOwnProperty.call(doc, "metadataVersion"),
    metadataVersion: doc.metadataVersion,
    hadMetadata: Object.prototype.hasOwnProperty.call(doc, "metadata"),
    metadata: doc.metadata === undefined ? undefined : structuredClone(doc.metadata),
  };
}

function restorePreMigrationFields(currentDoc, snapshot) {
  const restored = structuredClone(currentDoc);
  if (snapshot.hadMetadataVersion) {
    restored.metadataVersion = snapshot.metadataVersion;
  } else {
    delete restored.metadataVersion;
  }
  if (snapshot.hadMetadata) {
    restored.metadata = structuredClone(snapshot.metadata);
  } else {
    delete restored.metadata;
  }
  return restored;
}

function computeMetadataStateHash(doc) {
  return sha256({
    metadataVersion: doc.metadataVersion ?? null,
    metadata: doc.metadata ?? null,
  });
}

function buildEligibleQuery(targetVersion, filter = {}, lastProcessedId = null) {
  const versionCondition = {
    $or: [
      { metadataVersion: { $lt: targetVersion } },
      { metadataVersion: { $exists: false } },
    ],
  };

  const parts = [versionCondition];
  if (filter && Object.keys(filter).length > 0) {
    parts.push(filter);
  }
  if (lastProcessedId !== null && lastProcessedId !== undefined) {
    parts.push({ _id: { $gt: lastProcessedId } });
  }

  return parts.length === 1 ? parts[0] : { $and: parts };
}

async function appendRunEvent(runsCollection, runId, setFields, event) {
  await runsCollection.updateOne(
    { _id: runId },
    {
      $set: setFields,
      $push: { history: event },
    }
  );
}

/**
 * Inspects current material metadata version distribution and recent runs.
 */
export async function getMaterialMetadataMigrationStatus(db, { limit = 10 } = {}) {
  const materials = db.collection("materials");
  const runs = db.collection(METADATA_MIGRATION_RUNS_COLLECTION);

  const allMaterials = await materials.find({}).toArray();
  const versionCounts = {};
  for (const doc of allMaterials) {
    const v = String(getEffectiveMetadataVersion(doc));
    versionCounts[v] = (versionCounts[v] || 0) + 1;
  }

  const recentRuns = await runs.find({}).sort({ _id: 1 }).limit(limit).toArray();
  const unresolvedRuns = recentRuns.filter(
    (r) => ACTIVE_RUN_STATES.includes(r.state) || UNRESOLVED_RUN_STATES.includes(r.state)
  );

  return {
    currentVersion: CURRENT_METADATA_VERSION,
    totalMaterials: allMaterials.length,
    versionCounts,
    unresolvedRunCount: unresolvedRuns.length,
    recentRuns: recentRuns.map((r) => ({
      runId: r._id,
      state: r.state,
      targetVersion: r.targetVersion,
      migratedCount: r.migratedCount ?? 0,
      rolledBackCount: r.rolledBackCount ?? 0,
      failedCount: r.failedCount ?? 0,
      startedAt: r.startedAt,
      updatedAt: r.updatedAt,
    })),
  };
}

/**
 * Executes a rollback of all applied snapshots belonging to `runId`.
 *
 * Detects concurrent post-migration edits by comparing the document's current
 * metadata hash with `postMigrationHash`. Conflicting documents are skipped
 * unless `force: true` is explicitly passed.
 */
export async function rollbackMaterialMetadataMigration(
  db,
  {
    runId,
    actor,
    force = false,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    sleep = defaultSleep,
    now = () => new Date(),
  } = {}
) {
  assertMetadataMigrationAuthorized(actor);
  if (!runId || typeof runId !== "string") {
    throw new AppError("VALIDATION_FIELD", {
      message: "runId is required to roll back a metadata migration.",
      details: { field: "runId" },
    });
  }

  const runs = db.collection(METADATA_MIGRATION_RUNS_COLLECTION);
  const snapshots = db.collection(METADATA_MIGRATION_SNAPSHOTS_COLLECTION);
  const materials = db.collection("materials");

  const run = await runs.findOne({ _id: runId });
  if (!run) {
    throw new AppError("NOT_FOUND", {
      message: `Metadata migration run "${runId}" was not found.`,
      details: { runId },
    });
  }

  if (run.state === MetadataMigrationState.ROLLED_BACK) {
    return {
      runId,
      state: run.state,
      replayed: true,
      rolledBackCount: run.rolledBackCount ?? 0,
      conflicts: run.rollbackConflicts ?? [],
      failedRollbacks: [],
    };
  }

  if (run.state === MetadataMigrationState.RUNNING) {
    throw new AppError("CONFLICT_IN_PROGRESS", {
      message: `Run "${runId}" is currently running and cannot be rolled back concurrently.`,
      details: { runId, state: run.state },
    });
  }

  await appendRunEvent(
    runs,
    runId,
    { state: MetadataMigrationState.ROLLING_BACK, updatedAt: now() },
    { action: "rollback_started", actor: actor?.id ?? null, force, at: now() }
  );

  const pendingSnapshots = await snapshots
    .find({ runId, status: "applied" })
    .sort({ _id: 1 })
    .toArray();

  let rolledBackCount = run.rolledBackCount ?? 0;
  const conflicts = [];
  const failedRollbacks = [];

  for (const snap of pendingSnapshots) {
    try {
      const currentDoc = await withRetry(
        () => materials.findOne({ _id: snap.materialId }),
        { maxRetries, retryDelayMs, sleep }
      );

      if (!currentDoc) {
        conflicts.push({
          materialId: String(snap.materialId),
          reason: "document_deleted_after_migration",
        });
        continue;
      }

      const currentHash = computeMetadataStateHash(currentDoc);
      if (currentHash !== snap.postMigrationHash && !force) {
        conflicts.push({
          materialId: String(snap.materialId),
          reason: "metadata_modified_after_migration",
          expectedHash: snap.postMigrationHash,
          actualHash: currentHash,
        });
        continue;
      }

      const restoredDoc = restorePreMigrationFields(currentDoc, snap.before);
      await withRetry(
        () => materials.replaceOne({ _id: snap.materialId }, restoredDoc),
        { maxRetries, retryDelayMs, sleep }
      );

      await withRetry(
        () =>
          snapshots.updateOne(
            { _id: snap._id },
            {
              $set: {
                status: "rolled_back",
                rolledBackAt: now(),
                forcedOverride: currentHash !== snap.postMigrationHash && force,
              },
            }
          ),
        { maxRetries, retryDelayMs, sleep }
      );

      rolledBackCount += 1;
    } catch (error) {
      failedRollbacks.push({
        materialId: String(snap.materialId),
        error: formatErrorMessage(error),
      });
    }
  }

  let finalState;
  if (failedRollbacks.length > 0) {
    finalState = MetadataMigrationState.ROLLBACK_FAILED;
  } else if (conflicts.length > 0) {
    finalState = MetadataMigrationState.PARTIALLY_ROLLED_BACK;
  } else {
    finalState = MetadataMigrationState.ROLLED_BACK;
  }

  await appendRunEvent(
    runs,
    runId,
    {
      state: finalState,
      rolledBackCount,
      rollbackConflicts: conflicts,
      rollbackErrors: failedRollbacks,
      updatedAt: now(),
      ...(finalState === MetadataMigrationState.ROLLED_BACK ? { rolledBackAt: now() } : {}),
    },
    {
      action: finalState,
      actor: actor?.id ?? null,
      rolledBackCount,
      conflictCount: conflicts.length,
      errorCount: failedRollbacks.length,
      at: now(),
    }
  );

  return {
    runId,
    state: finalState,
    replayed: false,
    rolledBackCount,
    conflicts,
    failedRollbacks,
  };
}

/**
 * Runs a forward versioned material metadata migration with per-document
 * snapshots, transient retries, and automatic or manual rollback.
 */
export async function migrateMaterialMetadata(
  db,
  {
    actor,
    targetVersion = CURRENT_METADATA_VERSION,
    runId = crypto.randomUUID(),
    dryRun = false,
    batchSize = DEFAULT_BATCH_SIZE,
    filter = {},
    autoRollback = true,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    registry = DEFAULT_METADATA_MIGRATIONS,
    sleep = defaultSleep,
    now = () => new Date(),
  } = {}
) {
  assertMetadataMigrationAuthorized(actor);
  assertValidTargetVersion(targetVersion, registry);

  const effectiveBatchSize = Math.max(1, Number(batchSize || DEFAULT_BATCH_SIZE));
  const materials = db.collection("materials");
  const runs = db.collection(METADATA_MIGRATION_RUNS_COLLECTION);
  const snapshots = db.collection(METADATA_MIGRATION_SNAPSHOTS_COLLECTION);

  // Dry-run previews planned transitions without mutating DB or creating locks.
  if (dryRun) {
    const query = buildEligibleQuery(targetVersion, filter);
    const eligible = await materials.find(query).sort({ _id: 1 }).toArray();
    const sampleDiffs = [];
    const validationErrors = [];

    for (const doc of eligible) {
      const fromVersion = getEffectiveMetadataVersion(doc);
      try {
        const upgraded = applyForwardSteps(doc, fromVersion, targetVersion, registry);
        if (sampleDiffs.length < 10) {
          sampleDiffs.push({
            materialId: String(doc._id),
            fromVersion,
            toVersion: targetVersion,
            before: { metadataVersion: doc.metadataVersion ?? null, metadata: doc.metadata ?? null },
            after: { metadataVersion: upgraded.metadataVersion, metadata: upgraded.metadata },
          });
        }
      } catch (error) {
        validationErrors.push({
          materialId: String(doc._id),
          fromVersion,
          error: formatErrorMessage(error),
        });
      }
    }

    return {
      runId,
      dryRun: true,
      targetVersion,
      eligibleCount: eligible.length,
      migratedCount: 0,
      validationErrors,
      sampleDiffs,
    };
  }

  // Idempotent replay check for caller-supplied runId.
  const existingRun = await runs.findOne({ _id: runId });
  if (existingRun) {
    if (existingRun.state === MetadataMigrationState.COMPLETED) {
      return {
        runId,
        state: existingRun.state,
        replayed: true,
        targetVersion: existingRun.targetVersion,
        migratedCount: existingRun.migratedCount ?? 0,
        skippedCount: existingRun.skippedCount ?? 0,
        failedCount: 0,
      };
    }
    throw new AppError("CONFLICT_STATE", {
      message: `Run "${runId}" already exists in state "${existingRun.state}". Use retry or rollback instead.`,
      details: { runId, state: existingRun.state },
    });
  }

  // Prevent overlapping migrations or stacking on top of an unresolved failure.
  const activeRun = await runs.findOne({ state: { $in: ACTIVE_RUN_STATES } });
  if (activeRun) {
    throw new AppError("CONFLICT_IN_PROGRESS", {
      message: `Another metadata migration run ("${activeRun._id}") is currently ${activeRun.state}.`,
      details: { blockingRunId: activeRun._id, state: activeRun.state },
    });
  }

  const unresolvedRun = await runs.findOne({ state: { $in: UNRESOLVED_RUN_STATES } });
  if (unresolvedRun) {
    throw new AppError("CONFLICT_STATE", {
      message: `Previous metadata migration run "${unresolvedRun._id}" is unresolved (${unresolvedRun.state}). Retry or roll it back before starting a new run.`,
      details: { blockingRunId: unresolvedRun._id, state: unresolvedRun.state },
    });
  }

  const runRecord = {
    _id: runId,
    state: MetadataMigrationState.RUNNING,
    targetVersion,
    filter,
    autoRollback,
    actor: actor?.id ?? null,
    migratedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    rolledBackCount: 0,
    lastProcessedId: null,
    startedAt: now(),
    updatedAt: now(),
    history: [
      {
        action: "started",
        actor: actor?.id ?? null,
        targetVersion,
        at: now(),
      },
    ],
  };

  await runs.insertOne(runRecord);

  return executeForwardBatches({
    db,
    runId,
    actor,
    targetVersion,
    filter,
    batchSize: effectiveBatchSize,
    autoRollback,
    maxRetries,
    retryDelayMs,
    registry,
    sleep,
    now,
    initialMigratedCount: 0,
    initialSkippedCount: 0,
    materials,
    runs,
    snapshots,
  });
}

async function executeForwardBatches({
  db,
  runId,
  actor,
  targetVersion,
  filter,
  batchSize,
  autoRollback,
  maxRetries,
  retryDelayMs,
  registry,
  sleep,
  now,
  initialMigratedCount,
  initialSkippedCount,
  materials,
  runs,
  snapshots,
}) {
  let migratedCount = initialMigratedCount;
  let skippedCount = initialSkippedCount;
  let lastProcessedId = null;
  let failure = null;

  while (true) {
    const query = buildEligibleQuery(targetVersion, filter, lastProcessedId);
    const batch = await withRetry(
      () => materials.find(query).sort({ _id: 1 }).limit(batchSize).toArray(),
      { maxRetries, retryDelayMs, sleep }
    );

    if (batch.length === 0) break;

    for (const doc of batch) {
      lastProcessedId = doc._id;
      const fromVersion = getEffectiveMetadataVersion(doc);
      if (fromVersion >= targetVersion) {
        skippedCount += 1;
        continue;
      }

      const snapshotId = `${runId}:${String(doc._id)}`;
      const existingSnap = await snapshots.findOne({ _id: snapshotId });
      if (existingSnap && existingSnap.status === "applied") {
        skippedCount += 1;
        continue;
      }

      try {
        const upgraded = applyForwardSteps(doc, fromVersion, targetVersion, registry);
        const before = capturePreMigrationFields(doc);
        const postMigrationHash = computeMetadataStateHash(upgraded);

        await withRetry(
          () =>
            snapshots.replaceOne(
              { _id: snapshotId },
              {
                _id: snapshotId,
                runId,
                materialId: doc._id,
                fromVersion,
                toVersion: targetVersion,
                before,
                postMigrationHash,
                status: "pending",
                createdAt: now(),
              },
              { upsert: true }
            ),
          { maxRetries, retryDelayMs, sleep }
        );

        await withRetry(
          () => materials.replaceOne({ _id: doc._id }, upgraded),
          { maxRetries, retryDelayMs, sleep }
        );

        await withRetry(
          () =>
            snapshots.updateOne(
              { _id: snapshotId },
              { $set: { status: "applied", appliedAt: now() } }
            ),
          { maxRetries, retryDelayMs, sleep }
        );

        migratedCount += 1;
      } catch (error) {
        failure = {
          materialId: String(doc._id),
          fromVersion,
          toVersion: targetVersion,
          error: formatErrorMessage(error),
        };
        break;
      }
    }

    await runs.updateOne(
      { _id: runId },
      {
        $set: {
          migratedCount,
          skippedCount,
          lastProcessedId: lastProcessedId !== null ? String(lastProcessedId) : null,
          updatedAt: now(),
        },
      }
    );

    if (failure) break;
  }

  if (!failure) {
    await appendRunEvent(
      runs,
      runId,
      {
        state: MetadataMigrationState.COMPLETED,
        migratedCount,
        skippedCount,
        failedCount: 0,
        completedAt: now(),
        updatedAt: now(),
      },
      { action: "completed", actor: actor?.id ?? null, migratedCount, skippedCount, at: now() }
    );

    return {
      runId,
      state: MetadataMigrationState.COMPLETED,
      replayed: false,
      targetVersion,
      migratedCount,
      skippedCount,
      failedCount: 0,
    };
  }

  await appendRunEvent(
    runs,
    runId,
    {
      state: MetadataMigrationState.FAILED,
      migratedCount,
      skippedCount,
      failedCount: 1,
      failure,
      updatedAt: now(),
    },
    { action: "failed", actor: actor?.id ?? null, failure, at: now() }
  );

  if (autoRollback) {
    const rollbackResult = await rollbackMaterialMetadataMigration(db, {
      runId,
      actor,
      force: false,
      maxRetries,
      retryDelayMs,
      sleep,
      now,
    });

    return {
      runId,
      state: rollbackResult.state,
      replayed: false,
      targetVersion,
      migratedCount,
      skippedCount,
      failedCount: 1,
      failure,
      rollback: rollbackResult,
    };
  }

  return {
    runId,
    state: MetadataMigrationState.FAILED,
    replayed: false,
    targetVersion,
    migratedCount,
    skippedCount,
    failedCount: 1,
    failure,
  };
}

/**
 * Retries a previously failed forward migration or failed/partial rollback.
 *
 * - For `FAILED`: resumes forward migration for remaining eligible documents.
 * - For `ROLLBACK_FAILED` or `PARTIALLY_ROLLED_BACK`: resumes rolling back
 *   any remaining applied snapshots.
 * - For `COMPLETED` or `ROLLED_BACK`: returns idempotently with `replayed: true`.
 */
export async function retryMaterialMetadataMigration(
  db,
  {
    runId,
    actor,
    batchSize = DEFAULT_BATCH_SIZE,
    autoRollback,
    force = false,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    registry = DEFAULT_METADATA_MIGRATIONS,
    sleep = defaultSleep,
    now = () => new Date(),
  } = {}
) {
  assertMetadataMigrationAuthorized(actor);
  if (!runId || typeof runId !== "string") {
    throw new AppError("VALIDATION_FIELD", {
      message: "runId is required to retry a metadata migration.",
      details: { field: "runId" },
    });
  }

  const runs = db.collection(METADATA_MIGRATION_RUNS_COLLECTION);
  const snapshots = db.collection(METADATA_MIGRATION_SNAPSHOTS_COLLECTION);
  const materials = db.collection("materials");

  const run = await runs.findOne({ _id: runId });
  if (!run) {
    throw new AppError("NOT_FOUND", {
      message: `Metadata migration run "${runId}" was not found.`,
      details: { runId },
    });
  }

  if (
    run.state === MetadataMigrationState.COMPLETED ||
    run.state === MetadataMigrationState.ROLLED_BACK
  ) {
    return {
      runId,
      state: run.state,
      replayed: true,
      targetVersion: run.targetVersion,
      migratedCount: run.migratedCount ?? 0,
      rolledBackCount: run.rolledBackCount ?? 0,
    };
  }

  if (ACTIVE_RUN_STATES.includes(run.state)) {
    throw new AppError("CONFLICT_IN_PROGRESS", {
      message: `Run "${runId}" is already ${run.state}.`,
      details: { runId, state: run.state },
    });
  }

  if (
    run.state === MetadataMigrationState.ROLLBACK_FAILED ||
    run.state === MetadataMigrationState.PARTIALLY_ROLLED_BACK
  ) {
    return rollbackMaterialMetadataMigration(db, {
      runId,
      actor,
      force,
      maxRetries,
      retryDelayMs,
      sleep,
      now,
    });
  }

  // Resume forward migration for a FAILED run.
  await appendRunEvent(
    runs,
    runId,
    { state: MetadataMigrationState.RUNNING, failure: null, updatedAt: now() },
    { action: "retry_started", actor: actor?.id ?? null, at: now() }
  );

  return executeForwardBatches({
    db,
    runId,
    actor,
    targetVersion: run.targetVersion,
    filter: run.filter || {},
    batchSize: Math.max(1, Number(batchSize || DEFAULT_BATCH_SIZE)),
    autoRollback: autoRollback ?? Boolean(run.autoRollback),
    maxRetries,
    retryDelayMs,
    registry,
    sleep,
    now,
    initialMigratedCount: run.migratedCount ?? 0,
    initialSkippedCount: run.skippedCount ?? 0,
    materials,
    runs,
    snapshots,
  });
}
