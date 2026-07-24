import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { MongoClient } from "mongodb";

const PROJECT_ROOT = path.resolve(
  import.meta.dirname,
  "../..",
);

const MONGODB_BASE_URI =
  process.env.MONGODB_TEST_URI ||
  "mongodb://127.0.0.1:27017";

const TEST_DB_NAME =
  "eduvault_migration_duplicate_test";

const TEST_MONGODB_URI =
  `${MONGODB_BASE_URI}/${TEST_DB_NAME}`;

function runMigration({
  target = null,
  expectedExitCode = 0,
} = {}) {
  return new Promise((resolve, reject) => {
    const argumentsList = [
      "scripts/migrations/migrate-db.mjs",
    ];

    if (target !== null) {
      argumentsList.push(`--target=${target}`);
    }

    const child = spawn(
      process.execPath,
      argumentsList,
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          MONGODB_URI: TEST_MONGODB_URI,
          MONGODB_DB: TEST_DB_NAME,
          MIGRATION_DUPLICATE_BATCH_SIZE: "2",
        },
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", reject);

    child.once("close", (exitCode) => {
      if (exitCode !== expectedExitCode) {
        reject(
          new Error(
            [
              `Migration exited with code ${exitCode}.`,
              "",
              "STDOUT:",
              stdout,
              "",
              "STDERR:",
              stderr,
            ].join("\n"),
          ),
        );

        return;
      }

      resolve({
        exitCode,
        stdout,
        stderr,
      });
    });
  });
}

async function connectTestDatabase() {
  const client = new MongoClient(
    TEST_MONGODB_URI,
    {
      serverSelectionTimeoutMS: 5000,
    },
  );

  await client.connect();

  return {
    client,
    db: client.db(TEST_DB_NAME),
  };
}

test(
  "archives legacy duplicates and preserves the newest purchase",
  {
    timeout: 30_000,
  },
  async (context) => {
    const { client, db } =
      await connectTestDatabase();

    context.after(async () => {
      await db.dropDatabase();
      await client.close();
    });

    await db.dropDatabase();

    const initialMigration =
      await runMigration({
        target: 1,
      });

    assert.match(
      initialMigration.stdout,
      /Completed 1: initialize-documented-schema/,
    );

    assert.doesNotMatch(
      initialMigration.stdout,
      /Applying 2:/,
    );

    const purchases =
      db.collection("purchases");

    const olderPurchase = {
      materialId: "material-001",
      buyerAddress: "GABC123",
      status: "confirmed",
      chainTxHash: "tx-001",
      createdAt: new Date(
        "2026-01-01T10:00:00.000Z",
      ),
      updatedAt: new Date(
        "2026-01-01T10:00:00.000Z",
      ),
    };

    const newerPurchase = {
      materialId: "material-001",
      buyerAddress: "GABC123",
      status: "confirmed",
      chainTxHash: "tx-002",
      createdAt: new Date(
        "2026-01-02T10:00:00.000Z",
      ),
      updatedAt: new Date(
        "2026-01-02T10:00:00.000Z",
      ),
    };

    const insertion =
      await purchases.insertMany([
        olderPurchase,
        newerPurchase,
      ]);

    const olderPurchaseId =
      insertion.insertedIds[0];

    const newerPurchaseId =
      insertion.insertedIds[1];

    const migrationResult =
      await runMigration();

    assert.match(
      migrationResult.stdout,
      /Skipping completed migration 1/,
    );

    assert.match(
      migrationResult.stdout,
      /Completed 2: resolve-legacy-duplicates/,
    );

    assert.match(
      migrationResult.stdout,
      /Completed 3: enforce-unique-indexes/,
    );

    const remainingPurchases =
      await purchases
        .find({})
        .toArray();

    assert.equal(
      remainingPurchases.length,
      1,
      "Only one purchase should remain",
    );

    assert.equal(
      String(remainingPurchases[0]._id),
      String(newerPurchaseId),
      "The newest purchase should be preserved",
    );

    assert.equal(
      remainingPurchases[0].chainTxHash,
      "tx-002",
    );

    const conflicts = await db
      .collection("_migration_conflicts")
      .find({
        migrationVersion: 2,
        sourceCollection: "purchases",
        indexName:
          "purchases_material_buyer_unique",
      })
      .toArray();

    assert.equal(
      conflicts.length,
      1,
      "The removed duplicate should be archived",
    );

    const conflict = conflicts[0];

    assert.equal(
      String(conflict.sourceId),
      String(olderPurchaseId),
    );

    assert.equal(
      String(conflict.canonicalSourceId),
      String(newerPurchaseId),
    );

    assert.equal(
      conflict.archivedDocument.chainTxHash,
      "tx-001",
    );

    assert.deepEqual(
      conflict.duplicateKey,
      {
        materialId: "material-001",
        buyerAddress: "GABC123",
      },
    );

    const indexes =
      await purchases.indexes();

    const uniquePurchaseIndex =
      indexes.find(
        (index) =>
          index.name ===
          "purchases_material_buyer_unique",
      );

    assert.ok(
      uniquePurchaseIndex,
      "The purchase uniqueness index should exist",
    );

    assert.equal(
      uniquePurchaseIndex.unique,
      true,
    );

    await assert.rejects(
      purchases.insertOne({
        materialId: "material-001",
        buyerAddress: "GABC123",
        status: "confirmed",
        chainTxHash: "tx-003",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      (error) => {
        assert.equal(error.code, 11000);
        return true;
      },
      "MongoDB should reject a new duplicate purchase",
    );
  },
);