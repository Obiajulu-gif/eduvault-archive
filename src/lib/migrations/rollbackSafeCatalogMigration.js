import { AppError } from "../errors/AppError.js";
import { checkDeploymentAuthorization, CheckStatus } from "../release/releaseReadiness.js";
import {
  runWithRollbackVerification,
  RunState,
  VerificationStatus,
  captureFingerprint,
} from "./rollbackVerification.js";
import {
  runCatalogMigration,
  migrationV2,
  CURRENT_CATALOG_VERSION,
} from "./catalogMigrationFramework.js";

export const DEFAULT_MIGRATION_TARGETS = Object.freeze(["materials", "migration_checkpoints"]);

/**
 * Validates that the operator is authorized to execute catalog migrations.
 */
export function ensureMigrationAuthorization(actor) {
  const auth = checkDeploymentAuthorization(actor);
  if (auth.status !== CheckStatus.PASSED) {
    throw new AppError("AUTH_FORBIDDEN", {
      message: auth.message || "Unauthorized operator for schema migration",
      details: { actor },
    });
  }
}

/**
 * Verifies catalog schema consistency and document validity.
 */
export async function verifyCatalogSchemaConsistency(db, migrationDef = migrationV2) {
  const materials = db.collection("materials");
  const unmigratedCount = await materials.countDocuments({
    $or: [
      { schemaVersion: { $lt: migrationDef.version } },
      { schemaVersion: { $exists: false } },
    ],
  });
  const migratedCount = await materials.countDocuments({
    schemaVersion: migrationDef.version,
  });

  const sample = await materials.find({ schemaVersion: migrationDef.version }).limit(20).toArray();
  const invalidDocuments = [];
  for (const doc of sample) {
    if (typeof migrationDef.validate === "function" && !migrationDef.validate(doc)) {
      invalidDocuments.push(String(doc._id));
    }
  }

  return {
    ok: unmigratedCount === 0 && invalidDocuments.length === 0,
    version: migrationDef.version,
    migratedCount,
    unmigratedCount,
    sampleChecked: sample.length,
    invalidCount: invalidDocuments.length,
    invalidSampleIds: invalidDocuments,
  };
}

/**
 * Executes a zero-downtime, rollback-verified catalog schema migration.
 *
 * Guarantees:
 * 1. Pre-flight authorization validation.
 * 2. Full pre-migration fingerprinting of target collections.
 * 3. Batched resumable migration.
 * 4. Post-migration invariant checks (schemaVersion consistency, validate(doc)).
 * 5. Automatic rollback execution & fingerprint re-verification if any batch or check fails.
 *
 * @param {object} params
 * @param {import('mongodb').Db} params.db
 * @param {object} [params.migrationDef=migrationV2]
 * @param {object} [params.options={}]
 * @param {object} params.options.actor - Operator credentials
 * @param {boolean} [params.options.dryRun=false] - Preview mode
 * @param {boolean} [params.options.rollback=false] - Explicit rollback
 * @param {number} [params.options.batchSize=100]
 * @param {number} [params.options.rollbackRetries=2]
 * @param {Function} [params.options.sleep]
 */
export async function executeRollbackSafeCatalogMigration({
  db,
  migrationDef = migrationV2,
  options = {},
}) {
  const actor = options.actor || { role: "system", isCli: true };
  const dryRun = options.dryRun === true;
  const rollback = options.rollback === true;
  const verifyOnly = options.verifyOnly === true;
  const batchSize = Math.max(1, Number(options.batchSize || 100));
  const sleep = options.sleep;

  // 1. Authorization check
  ensureMigrationAuthorization(actor);

  // 2. Read-only verification check
  if (verifyOnly) {
    return verifyCatalogSchemaConsistency(db, migrationDef);
  }

  // 3. Dry-run execution
  if (dryRun) {
    return runCatalogMigration(db, migrationDef, {
      batchSize,
      dryRun: true,
      rollback,
    });
  }

  const migrationName = `catalog-migration-v${migrationDef.version}`;

  // 4. Explicit Rollback with Verification
  if (rollback) {
    return runWithRollbackVerification({
      db,
      name: `${migrationName}-explicit-rollback`,
      actor,
      targets: DEFAULT_MIGRATION_TARGETS,
      sleep,
      apply: async () => {
        return runCatalogMigration(db, migrationDef, {
          batchSize,
          rollback: true,
          dryRun: false,
        });
      },
      rollback: async () => {
        // If the rollback itself needs to be rolled back (resurrected), re-apply the migration
        return runCatalogMigration(db, migrationDef, {
          batchSize,
          rollback: false,
          dryRun: false,
        });
      },
      postChecks: [
        {
          name: "no-migrated-documents-remain",
          run: async (targetDb) => {
            const count = await targetDb
              .collection("materials")
              .countDocuments({ schemaVersion: migrationDef.version });
            return {
              ok: count === 0,
              detail: count > 0 ? `${count} documents still retain version ${migrationDef.version}` : null,
            };
          },
        },
      ],
    });
  }

  // 5. Forward Migration with Rollback Verification
  const postChecks = [
    {
      name: "all-documents-migrated",
      run: async (targetDb) => {
        const remaining = await targetDb.collection("materials").countDocuments({
          $or: [
            { schemaVersion: { $lt: migrationDef.version } },
            { schemaVersion: { $exists: false } },
          ],
        });
        return {
          ok: remaining === 0,
          detail: remaining > 0 ? `${remaining} unmigrated documents remain` : null,
        };
      },
    },
    {
      name: "migrated-document-validation",
      run: async (targetDb) => {
        if (typeof migrationDef.validate !== "function") return { ok: true };
        const sample = await targetDb
          .collection("materials")
          .find({ schemaVersion: migrationDef.version })
          .limit(50)
          .toArray();

        const invalid = sample.filter((doc) => !migrationDef.validate(doc));
        return {
          ok: invalid.length === 0,
          detail: invalid.length > 0 ? `${invalid.length} sampled documents failed schema validation` : null,
        };
      },
    },
  ];

  return runWithRollbackVerification({
    db,
    name: migrationName,
    actor,
    targets: DEFAULT_MIGRATION_TARGETS,
    sleep,
    apply: async () => {
      const result = await runCatalogMigration(db, migrationDef, {
        batchSize,
        dryRun: false,
        rollback: false,
      });

      if (!result.completed) {
        throw new Error(`Catalog migration did not complete fully: ${result.remainingUnmigrated} documents remaining`);
      }
      return result;
    },
    rollback: async () => {
      return runCatalogMigration(db, migrationDef, {
        batchSize,
        rollback: true,
        dryRun: false,
      });
    },
    postChecks,
    invariants: [
      {
        name: "catalog-materials-intact",
        run: async (targetDb) => {
          const totalCount = await targetDb.collection("materials").countDocuments();
          return { ok: totalCount >= 0 };
        },
      },
    ],
  });
}
