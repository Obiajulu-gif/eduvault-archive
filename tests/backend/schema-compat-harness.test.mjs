/**
 * Schema compatibility tests for versioned records — Issue #1083
 *
 * Normal path: every registered schema passes the registry-driven harness and
 * the golden v2 snapshot. Failure paths: the harness catches missing steps,
 * lossy rollbacks, mutating / non-idempotent / non-deterministic migrations,
 * unsupported versions, and collections registered without fixtures. Retry:
 * re-reads and repeated runs are stable; the retirement preflight is
 * read-only and repeatable. Authorization: the preflight requires
 * `schema:retire`.
 */

import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { getRecordSchema, readRecord, registerRecordSchema, writeRecord } from "../../src/lib/backend/schemaCompat.js";
import {
  SchemaCompatError,
  assertRecordSchemasCompatible,
  checkAllRecordSchemas,
  checkRecordSchemaCompatibility,
  checkSchemaFloorRaise,
} from "../../src/lib/backend/schemaCompatHarness.js";
import { MATERIAL_CLEAN_V2_GOLDEN, RECORD_SCHEMA_FIXTURES } from "../../src/lib/backend/schemaCompatFixtures.js";
import { legacyMaterialFixturesByName } from "../../src/lib/migrations/__fixtures__/legacy/index.js";
import { migrationV2, runCatalogMigration } from "../../src/lib/migrations/catalogMigrationFramework.js";
import { main as schemaCompatCli } from "../../scripts/check-schema-compat.mjs";
import { createMemoryMongo } from "./helpers/memoryMongo.mjs";

const admin = { id: "ops-1", role: "admin" };
const registered = [];
function register(collection, schema) {
  registered.push(collection);
  return registerRecordSchema(collection, { collection, ...schema });
}
after(() => {
  // Registry is process-global; leave only real schemas behind for other suites.
  for (const name of registered) registerRecordSchema(name, { latest: 1 });
});

const goodSteps = {
  2: {
    up: (doc) => ({ ...doc, schemaVersion: 2, tier: doc.tier ?? "basic" }),
    down: (doc) => {
      const { tier, ...rest } = doc;
      void tier;
      return { ...rest, schemaVersion: 1 };
    },
    validate: (doc) => typeof doc.tier === "string",
  },
};

describe("registered schemas (normal path)", () => {
  test("every registered schema passes against its fixtures", () => {
    const report = assertRecordSchemasCompatible(RECORD_SCHEMA_FIXTURES);
    const materials = report.results.find((r) => r.collection === "materials");
    assert.equal(materials.valid, true);
    assert.deepEqual(materials.warnings, []);
    assert.ok(materials.checks > 30);
  });

  test("the v1 → latest material shape matches the golden snapshot", () => {
    assert.deepEqual(readRecord("materials", legacyMaterialFixturesByName.clean.record), MATERIAL_CLEAN_V2_GOLDEN);
  });

  test("a v1 record with creator-set rightsMetadata survives an up/down round trip", () => {
    const v1 = RECORD_SCHEMA_FIXTURES.materials.find((r) => r._id === "compat-mat-rights-0001");
    const v2 = readRecord("materials", v1);
    assert.deepEqual(v2.rightsMetadata, { commercialUse: true, educationalOnly: true, distributionAllowed: false });
    assert.deepEqual(readRecord("materials", v2, { targetVersion: 1 }).rightsMetadata, { commercialUse: true });
    // Records that never had rightsMetadata keep the previous down() behaviour.
    const clean = readRecord("materials", MATERIAL_CLEAN_V2_GOLDEN, { targetVersion: 1 });
    assert.equal("rightsMetadata" in clean, false);
    assert.equal("legacyRightsMetadata" in MATERIAL_CLEAN_V2_GOLDEN, false);
  });

  test("runCatalogMigration rollback restores creator-set rightsMetadata", async () => {
    const v1 = RECORD_SCHEMA_FIXTURES.materials.find((r) => r._id === "compat-mat-rights-0001");
    const migrated = migrationV2.up({ ...v1 });
    const docs = new Map([[migrated._id, migrated]]);
    const db = {
      collection: () => ({
        find: () => {
          const queue = [...docs.values()];
          return { hasNext: async () => queue.length > 0, next: async () => queue.shift() };
        },
        replaceOne: async ({ _id }, doc) => docs.set(_id, doc),
        countDocuments: async () => docs.size,
        deleteOne: async () => ({ deletedCount: 1 }),
      }),
    };
    await runCatalogMigration(db, migrationV2, { rollback: true });
    assert.deepEqual(docs.get(v1._id), { ...v1, schemaVersion: 1 });
  });

  test("the CLI gate exits 0 for the shipped fixtures", async () => {
    const lines = [];
    assert.equal(await schemaCompatCli(["node", "check-schema-compat.mjs"], {}, (l) => lines.push(l)), 0);
    assert.equal(JSON.parse(lines[0]).valid, true);
    assert.equal(await schemaCompatCli(["node", "x", "--retire-below", "2"], {}, (l) => lines.push(l)), 1, "preflight needs a db + operator");
  });
});

describe("harness catches incompatible migrations (failure paths)", () => {
  const v1 = { _id: "r1", title: "t" };

  test("a well-behaved synthetic schema passes", () => {
    register("compat_good", { min: 1, latest: 2, migrations: goodSteps });
    const result = checkRecordSchemaCompatibility("compat_good", { fixtures: [v1, { _id: "r2", schemaVersion: 2, title: "t", tier: "pro" }] });
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("a missing down() step is reported", () => {
    register("compat_no_down", { min: 1, latest: 2, migrations: { 2: { up: goodSteps[2].up, validate: goodSteps[2].validate } } });
    const result = checkRecordSchemaCompatibility("compat_no_down", { fixtures: [v1] });
    assert.ok(result.errors.some((e) => e.check === "chain"));
  });

  test("a lossy rollback is reported", () => {
    register("compat_lossy", {
      min: 1,
      latest: 2,
      migrations: { 2: { ...goodSteps[2], down: (doc) => ({ _id: doc._id, schemaVersion: 1 }) } },
    });
    const result = checkRecordSchemaCompatibility("compat_lossy", { fixtures: [v1] });
    assert.deepEqual([...new Set(result.errors.map((e) => e.check))], ["round-trip"]);
  });

  test("a migration that mutates its input is reported", () => {
    // readRecord shallow-copies the top level, so the dangerous case is a
    // nested object shared with the stored document.
    register("compat_mutating", {
      min: 1,
      latest: 2,
      migrations: {
        2: {
          ...goodSteps[2],
          up: (doc) => {
            doc.meta.migrated = true;
            return { ...doc, schemaVersion: 2, tier: "basic" };
          },
        },
      },
    });
    const result = checkRecordSchemaCompatibility("compat_mutating", { fixtures: [{ ...v1, meta: {} }] });
    assert.ok(result.errors.some((e) => e.check === "pure"));
  });

  test("non-idempotent and non-deterministic migrations are reported", () => {
    let counter = 0;
    register("compat_random", {
      min: 1,
      latest: 2,
      migrations: { 2: { ...goodSteps[2], up: (doc) => ({ ...doc, schemaVersion: 2, tier: `t${(counter += 1)}` }) } },
    });
    const result = checkRecordSchemaCompatibility("compat_random", { fixtures: [v1] });
    assert.ok(result.errors.some((e) => e.check === "deterministic"));
  });

  test("an upgrade that fails validation is reported", () => {
    register("compat_invalid", { min: 1, latest: 2, migrations: { 2: { ...goodSteps[2], up: (doc) => ({ ...doc, schemaVersion: 2 }) } } });
    const result = checkRecordSchemaCompatibility("compat_invalid", { fixtures: [v1] });
    assert.ok(result.errors.some((e) => e.check === "validate"));
  });

  test("a fixture outside the supported range must be rejected, not misread", () => {
    register("compat_range", { min: 2, latest: 2, migrations: goodSteps });
    const result = checkRecordSchemaCompatibility("compat_range", { fixtures: [{ _id: "old", schemaVersion: 1 }, { _id: "ok", schemaVersion: 2, tier: "x" }] });
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    // Retired (below min) and future (above latest) versions are both 400s.
    assert.throws(() => readRecord("compat_range", { schemaVersion: 1 }), /Unsupported schema version/);
    assert.throws(() => writeRecord("compat_range", { schemaVersion: 1 }), /Unsupported schema version/);
    assert.throws(() => writeRecord("compat_range", { schemaVersion: 3 }), /Unsupported schema version/);
  });

  test("a registered collection without fixtures fails the whole gate", () => {
    register("compat_unfixtured", { min: 1, latest: 1 });
    const report = checkAllRecordSchemas({ ...RECORD_SCHEMA_FIXTURES, compat_good: [v1] });
    const unfixtured = report.results.find((r) => r.collection === "compat_unfixtured");
    assert.equal(unfixtured.valid, false);
    assert.equal(unfixtured.errors[0].check, "fixtures");
    assert.throws(() => assertRecordSchemasCompatible({}), (e) => e instanceof SchemaCompatError && e.code === "SCHEMA_INCOMPATIBLE");
  });
});

describe("retry and idempotency", () => {
  test("repeated harness runs produce identical reports", () => {
    const a = checkRecordSchemaCompatibility("materials", { fixtures: RECORD_SCHEMA_FIXTURES.materials });
    const b = checkRecordSchemaCompatibility("materials", { fixtures: RECORD_SCHEMA_FIXTURES.materials });
    assert.deepEqual(a, b);
  });

  test("re-reading an upgraded record (a retried backfill) changes nothing", () => {
    for (const fixture of RECORD_SCHEMA_FIXTURES.materials.filter((r) => (r.schemaVersion ?? 1) <= 2)) {
      const once = readRecord("materials", fixture);
      assert.deepEqual(readRecord("materials", once), once);
      assert.deepEqual(writeRecord("materials", once), once);
    }
  });
});

describe("retirement preflight (authorization + failure + retry)", () => {
  const seed = () =>
    createMemoryMongo({
      materials: [
        { _id: "a", schemaVersion: 2 },
        { _id: "b" },
        { _id: "c", schemaVersion: 1 },
        { _id: "d", schemaVersion: "1" },
        { _id: "e", schemaVersion: null },
      ],
    });

  test("requires the schema:retire permission", async () => {
    for (const actor of [null, { id: "u", role: "creator" }, { id: "s", role: "service" }]) {
      await assert.rejects(
        () => checkSchemaFloorRaise({ db: seed(), collection: "materials", newMin: 2, actor }),
        (e) => e instanceof SchemaCompatError && e.status === 403
      );
    }
  });

  test("counts unversioned, numeric and string-typed records below the floor", async () => {
    const db = seed();
    const result = await checkSchemaFloorRaise({ db, collection: "materials", newMin: 2, actor: admin });
    assert.equal(result.safe, false);
    assert.equal(result.remaining, 4);
    assert.deepEqual(result.sampleIds, ["b", "c", "d", "e"]);
    assert.equal(getRecordSchema("materials").min, 1, "the preflight never changes the registry");

    const again = await checkSchemaFloorRaise({ db, collection: "materials", newMin: 2, actor: admin });
    assert.deepEqual(again, result, "read-only and repeatable");
  });

  test("is safe once every record is at or above the floor", async () => {
    const db = createMemoryMongo({ materials: [{ _id: "a", schemaVersion: 2 }] });
    const result = await checkSchemaFloorRaise({ db, collection: "materials", newMin: 2, actor: admin });
    assert.equal(result.safe, true);
    assert.match(result.nextStep, /Raise min to 2/);
  });

  test("rejects floors that are not a real retirement", async () => {
    for (const newMin of [1, 3, 1.5, "2"]) {
      await assert.rejects(
        () => checkSchemaFloorRaise({ db: seed(), collection: "materials", newMin, actor: admin }),
        (e) => e.code === "SCHEMA_RETIRE_INVALID_FLOOR"
      );
    }
    await assert.rejects(() => checkSchemaFloorRaise({ db: seed(), collection: "nope", newMin: 2, actor: admin }), /Unknown record schema/);
  });
});
