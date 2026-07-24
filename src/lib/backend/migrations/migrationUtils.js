import { createHash, randomUUID } from "node:crypto";
import { COLLECTIONS } from "../schemaContracts.js";

const DEFAULT_LOCK_DURATION_MS = 60_000;

export function calculateMigrationChecksum(migration) {
  const canonicalValue = JSON.stringify({
    version: migration.version,
    name: migration.name,
    description: migration.description ?? "",
    up: migration.up.toString(),
    down: migration.down?.toString() ?? null,
  });

  return createHash("sha256")
    .update(canonicalValue, "utf8")
    .digest("hex");
}

export async function acquireMigrationLock(
  db,
  {
    ownerId = randomUUID(),
    lockDurationMs = DEFAULT_LOCK_DURATION_MS,
  } = {},
) {
  const collection = db.collection(COLLECTIONS.migrationLock);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + lockDurationMs);

  try {
    const result = await collection.findOneAndUpdate(
      {
        _id: "schema-migrations",
        $or: [
          { ownerId },
          { expiresAt: { $lte: now } },
          { expiresAt: { $exists: false } },
        ],
      },
      {
        $set: {
          ownerId,
          acquiredAt: now,
          heartbeatAt: now,
          expiresAt,
        },
      },
      {
        upsert: true,
        returnDocument: "after",
      },
    );

    if (!result || result.ownerId !== ownerId) {
      throw new Error("Migration lock is currently held by another process");
    }

    return {
      ownerId,
      expiresAt,
    };
  } catch (error) {
    if (error?.code === 11000) {
      throw new Error("Migration lock is currently held by another process", {
        cause: error,
      });
    }

    throw error;
  }
}

export async function refreshMigrationLock(
  db,
  ownerId,
  lockDurationMs = DEFAULT_LOCK_DURATION_MS,
) {
  const now = new Date();

  const result = await db
    .collection(COLLECTIONS.migrationLock)
    .updateOne(
      {
        _id: "schema-migrations",
        ownerId,
      },
      {
        $set: {
          heartbeatAt: now,
          expiresAt: new Date(now.getTime() + lockDurationMs),
        },
      },
    );

  if (result.matchedCount !== 1) {
    throw new Error("Migration lock was lost");
  }
}

export async function releaseMigrationLock(db, ownerId) {
  await db.collection(COLLECTIONS.migrationLock).deleteOne({
    _id: "schema-migrations",
    ownerId,
  });
}

export async function runInBatches({
  collection,
  filter,
  batchSize = 500,
  migrationVersion,
  transform,
  logger = console,
}) {
  let processed = 0;
  let lastId = null;

  while (true) {
    const batchFilter = {
      ...filter,
      ...(lastId ? { _id: { $gt: lastId } } : {}),
    };

    const documents = await collection
      .find(batchFilter)
      .sort({ _id: 1 })
      .limit(batchSize)
      .toArray();

    if (documents.length === 0) {
      break;
    }

    const operations = [];

    for (const document of documents) {
      const update = await transform(document);

      if (update) {
        operations.push({
          updateOne: {
            filter: {
              _id: document._id,
            },
            update,
          },
        });
      }
    }

    if (operations.length > 0) {
      await collection.bulkWrite(operations, {
        ordered: false,
      });
    }

    processed += documents.length;
    lastId = documents.at(-1)._id;

    logger.info?.("[migration] Batch completed", {
      migrationVersion,
      batchSize: documents.length,
      processed,
      lastId: String(lastId),
    });
  }

  return processed;
}