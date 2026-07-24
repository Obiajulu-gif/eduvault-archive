import crypto from "node:crypto";
import { hostname } from "node:os";
import process from "node:process";

import {
  closeMongoConnection,
  getDb,
} from "../../src/lib/mongodb.js";

import { COLLECTIONS } from "../../src/lib/backend/schemaContracts.js";

import {
  MIGRATIONS,
  validateMigrationRegistry,
} from "../../src/lib/backend/migrations/registry.js";

import {
  acquireMigrationLock,
  calculateMigrationChecksum,
  refreshMigrationLock,
  releaseMigrationLock,
} from "../../src/lib/backend/migrations/migrationUtils.js";

const LOCK_DURATION_MS = Number.parseInt(
  process.env.MIGRATION_LOCK_DURATION_MS || "60000",
  10,
);

const HEARTBEAT_INTERVAL_MS = Math.max(
  Math.floor(LOCK_DURATION_MS / 3),
  1000,
);

function buildOwnerId() {
  return [
    hostname(),
    process.pid,
    crypto.randomUUID(),
  ].join(":");
}

function getTargetVersion() {
  const targetArgument = process.argv.find((argument) =>
    argument.startsWith("--target="),
  );

  if (!targetArgument) {
    return null;
  }

  const rawTarget = targetArgument.slice("--target=".length);
  const targetVersion = Number.parseInt(rawTarget, 10);

  if (
    !Number.isSafeInteger(targetVersion) ||
    targetVersion <= 0 ||
    String(targetVersion) !== rawTarget
  ) {
    throw new Error(
      `Invalid migration target "${rawTarget}". Expected a positive integer.`,
    );
  }

  return targetVersion;
}

async function ensureMigrationInfrastructure(db) {
  const migrations = db.collection(
    COLLECTIONS.schemaMigrations,
  );

  const lock = db.collection(
    COLLECTIONS.migrationLock,
  );

  await migrations.createIndex(
    {
      version: 1,
    },
    {
      name: "schema_migrations_version_unique",
      unique: true,
    },
  );

  await lock.createIndex(
    {
      expiresAt: 1,
    },
    {
      name: "migration_lock_expires_at_ttl",
      expireAfterSeconds: 0,
    },
  );
}

async function getAppliedMigration(db, version) {
  return db
    .collection(COLLECTIONS.schemaMigrations)
    .findOne({
      version,
    });
}

async function executeMigration(db, migration) {
  const collection = db.collection(
    COLLECTIONS.schemaMigrations,
  );

  const checksum =
    calculateMigrationChecksum(migration);

  const existing = await getAppliedMigration(
    db,
    migration.version,
  );

  if (existing?.status === "completed") {
    if (existing.checksum !== checksum) {
      throw new Error(
        `Checksum drift detected for migration ${migration.version}: ${migration.name}`,
      );
    }

    console.log(
      `[migration] Skipping completed migration ${migration.version}: ${migration.name}`,
    );

    return;
  }

  if (
    existing &&
    existing.checksum !== checksum
  ) {
    throw new Error(
      `Checksum drift detected for incomplete migration ${migration.version}: ${migration.name}`,
    );
  }

  const startedAt = new Date();

  await collection.updateOne(
    {
      version: migration.version,
    },
    {
      $setOnInsert: {
        version: migration.version,
        name: migration.name,
        checksum,
        createdAt: startedAt,
      },
      $set: {
        status: "running",
        startedAt,
        completedAt: null,
        failedAt: null,
        error: null,
      },
      $inc: {
        attempts: 1,
      },
    },
    {
      upsert: true,
    },
  );

  try {
    console.log(
      `[migration] Applying ${migration.version}: ${migration.name}`,
    );

    const migrationIdentity = {
      version: migration.version,
      checksum,
    };

    const getCheckpoint = async () => {
      const migrationRecord =
        await collection.findOne(
          migrationIdentity,
          {
            projection: {
              checkpoint: 1,
            },
          },
        );

      return (
        migrationRecord?.checkpoint ?? null
      );
    };

    const saveCheckpoint = async (
      checkpoint,
    ) => {
      const result =
        await collection.updateOne(
          migrationIdentity,
          {
            $set: {
              checkpoint,
              checkpointUpdatedAt:
                new Date(),
            },
          },
        );

      if (result.matchedCount !== 1) {
        throw new Error(
          `Unable to save checkpoint for migration ${migration.version}`,
        );
      }
    };

    const clearCheckpoint = async () => {
      const result =
        await collection.updateOne(
          migrationIdentity,
          {
            $unset: {
              checkpoint: "",
              checkpointUpdatedAt: "",
            },
          },
        );

      if (result.matchedCount !== 1) {
        throw new Error(
          `Unable to clear checkpoint for migration ${migration.version}`,
        );
      }
    };

    await migration.up({
      db,
      logger: console,
      getCheckpoint,
      saveCheckpoint,
      clearCheckpoint,
    });

    await collection.updateOne(
      migrationIdentity,
      {
        $set: {
          status: "completed",
          completedAt: new Date(),
          error: null,
        },
        $unset: {
          checkpoint: "",
          checkpointUpdatedAt: "",
        },
      },
    );

    console.log(
      `[migration] Completed ${migration.version}: ${migration.name}`,
    );
  } catch (error) {
    await collection.updateOne(
      {
        version: migration.version,
        checksum,
      },
      {
        $set: {
          status: "failed",
          failedAt: new Date(),
          error: {
            name: error?.name,
            code: error?.code,
            codeName: error?.codeName,
            message: error?.message,
          },
        },
      },
    );

    throw error;
  }
}

async function migrate() {
  validateMigrationRegistry();

  const targetVersion =
    getTargetVersion();

  if (
    targetVersion !== null &&
    !MIGRATIONS.some(
      (migration) =>
        migration.version ===
        targetVersion,
    )
  ) {
    throw new Error(
      `Migration target ${targetVersion} does not exist`,
    );
  }

  const migrationsToRun =
    targetVersion === null
      ? MIGRATIONS
      : MIGRATIONS.filter(
          (migration) =>
            migration.version <=
            targetVersion,
        );

  const db = await getDb();

  await ensureMigrationInfrastructure(db);

  const ownerId = buildOwnerId();

  const lock =
    await acquireMigrationLock(db, {
      ownerId,
      lockDurationMs:
        LOCK_DURATION_MS,
    });

  console.log(
    "[migration] Lock acquired",
    {
      ownerId: lock.ownerId,
      expiresAt: lock.expiresAt,
    },
  );

  if (targetVersion !== null) {
    console.log(
      "[migration] Target selected",
      {
        targetVersion,
        migrations:
          migrationsToRun.map(
            (migration) =>
              migration.version,
          ),
      },
    );
  }

  const heartbeat = setInterval(() => {
    refreshMigrationLock(
      db,
      ownerId,
      LOCK_DURATION_MS,
    ).catch((error) => {
      console.error(
        "[migration] Lock heartbeat failed",
        {
          message: error?.message,
        },
      );
    });
  }, HEARTBEAT_INTERVAL_MS);

  heartbeat.unref();

  try {
    for (const migration of migrationsToRun) {
      await executeMigration(
        db,
        migration,
      );
    }
  } finally {
    clearInterval(heartbeat);

    await releaseMigrationLock(
      db,
      ownerId,
    );

    console.log(
      "[migration] Lock released",
      {
        ownerId,
      },
    );
  }
}

migrate()
  .catch((error) => {
    console.error(
      "[migration] Migration run failed",
      {
        name: error?.name,
        code: error?.code,
        codeName: error?.codeName,
        message: error?.message,
      },
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMongoConnection();
  });