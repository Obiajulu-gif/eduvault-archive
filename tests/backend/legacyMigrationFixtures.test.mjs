/**
 * Legacy migration fixture pack coverage (#890).
 *
 * Uses the deterministic fixtures in
 * `src/lib/migrations/__fixtures__/legacy/` to prove:
 *   1. each fixture validates (or is rejected) against the documented old shape;
 *   2. the existing catalog migration produces a current valid record from the
 *      clean legacy record;
 *   3. the missing / deprecated / incompatible cases are handled
 *      deterministically with documented behavior instead of crashing.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  legacyMaterialFixtures,
  legacyMaterialFixturesByName,
  validateLegacyMaterialShape,
  LEGACY_MATERIAL_SCHEMA_VERSION,
} from "../../src/lib/migrations/__fixtures__/legacy/index.js";
import {
  migrationV2,
  readCatalogMaterial,
  prepareCatalogWrite,
  runCatalogMigration,
  CURRENT_CATALOG_VERSION,
} from "../../src/lib/migrations/catalogMigrationFramework.js";
import {
  readRecord,
  writeRecord,
  UnsupportedSchemaVersionError,
} from "../../src/lib/backend/schemaCompat.js";

const byName = legacyMaterialFixturesByName;

describe("legacy fixture pack: old-shape validation (#890)", () => {
  test("the pack exposes all four documented record kinds", () => {
    assert.deepEqual(
      legacyMaterialFixtures.map((fixture) => fixture.kind).sort(),
      ["clean", "deprecated-field", "incompatible", "missing-field"]
    );
  });

  test("clean legacy record validates against the documented v1 shape", () => {
    const { record } = byName.clean;
    const result = validateLegacyMaterialShape(record);

    assert.equal(record.schemaVersion, undefined);
    assert.equal(result.valid, true);
    assert.equal(result.incompatible, false);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.missingFields, []);
    assert.deepEqual(result.warnings, []);
  });

  test("missing-field fixture is flagged by the v1 shape validator", () => {
    const { record } = byName["missing-field"];
    const result = validateLegacyMaterialShape(record);

    assert.equal(result.valid, false);
    assert.equal(result.incompatible, false);
    assert.deepEqual(result.missingFields, ["price"]);
    assert.equal(result.errors.length > 0, true);
  });

  test("deprecated-field fixture is valid but warns about the deprecated alias", () => {
    const { record } = byName["deprecated-field"];
    const result = validateLegacyMaterialShape(record);

    assert.equal(result.valid, true);
    assert.equal(record.stellarContractId, "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4");
    assert.equal(record.contractId, undefined);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /stellarContractId/);
  });

  test("incompatible fixture is rejected as unknown, not accepted as v1", () => {
    const { record } = byName.incompatible;
    const result = validateLegacyMaterialShape(record);

    assert.equal(record.schemaVersion, 99);
    assert.equal(result.valid, false);
    assert.equal(result.incompatible, true);
    assert.match(result.errors[0], /schemaVersion 99/);
  });

  test("legacy version constant matches the documented unversioned/v1 shape", () => {
    assert.equal(LEGACY_MATERIAL_SCHEMA_VERSION, 1);
  });
});

describe("legacy fixture pack: migration produces current valid records (#890)", () => {
  test("clean legacy record is upgraded to a current valid material by readRecord", () => {
    const { record } = byName.clean;
    const current = readRecord("materials", record);

    assert.equal(current.schemaVersion, CURRENT_CATALOG_VERSION);
    assert.equal(migrationV2.validate(current), true);
    assert.equal(current.pricingTier, "premium");
    assert.equal(current.sorobanEntitlementConfig.tokenStandard, "SEP-0041");
    assert.equal(current.rightsMetadata.educationalOnly, true);
    assert.equal(current.title, record.title);

    // The stored legacy document is never mutated in place.
    assert.equal(record.schemaVersion, undefined);
  });

  test("clean legacy record is stamped current by writeRecord and dual-read helpers", () => {
    const { record } = byName.clean;

    const written = writeRecord("materials", record);
    assert.equal(written.schemaVersion, CURRENT_CATALOG_VERSION);
    assert.equal(migrationV2.validate(written), true);

    const read = readCatalogMaterial(record);
    assert.equal(read.schemaVersion, CURRENT_CATALOG_VERSION);
    assert.equal(migrationV2.validate(read), true);

    const prepared = prepareCatalogWrite(record);
    assert.equal(prepared.schemaVersion, CURRENT_CATALOG_VERSION);
    assert.equal(migrationV2.validate(prepared), true);
  });

  test("the batch migration runner writes the clean fixture as a current valid record", async () => {
    const db = createInMemoryCatalogDb([byName.clean.record]);

    const report = await runCatalogMigration(db, migrationV2, { batchSize: 10 });

    assert.equal(report.completed, true);
    assert.equal(report.modifiedCount, 1);
    assert.equal(db._materials[0].schemaVersion, CURRENT_CATALOG_VERSION);
    assert.equal(migrationV2.validate(db._materials[0]), true);
    assert.equal(db._materials[0].pricingTier, "premium");
  });
});

describe("legacy fixture pack: deterministic handling of imperfect records (#890)", () => {
  test("missing price defaults to the free tier instead of throwing", () => {
    const { record } = byName["missing-field"];

    const migrated = readRecord("materials", record);

    assert.equal(migrated.schemaVersion, CURRENT_CATALOG_VERSION);
    assert.equal(migrated.pricingTier, "free");
    assert.equal(migrationV2.validate(migrated), true);
    assert.equal(migrated.title, record.title);
  });

  test("deprecated stellarContractId is normalized into the current contract id field", () => {
    const { record } = byName["deprecated-field"];

    const migrated = readRecord("materials", record);

    assert.equal(migrated.schemaVersion, CURRENT_CATALOG_VERSION);
    assert.equal(
      migrated.sorobanEntitlementConfig.contractId,
      record.stellarContractId
    );
    assert.equal(migrationV2.validate(migrated), true);
  });

  test("incompatible record is rejected with a typed 400 instead of a crash", () => {
    const { record } = byName.incompatible;

    assert.throws(
      () => readRecord("materials", record),
      (err) =>
        err instanceof UnsupportedSchemaVersionError &&
        err.status === 400 &&
        err.collection === "materials" &&
        err.version === 99
    );

    assert.throws(
      () => writeRecord("materials", record),
      UnsupportedSchemaVersionError
    );
  });

  test("the batch runner leaves out-of-range records untouched rather than mangling them", async () => {
    const db = createInMemoryCatalogDb([byName.incompatible.record]);

    const report = await runCatalogMigration(db, migrationV2, { batchSize: 10 });

    assert.equal(report.completed, true);
    assert.equal(report.processedCount, 0);
    assert.equal(db._materials[0].schemaVersion, 99);
    assert.equal(db._materials[0].unknownEntitlementModel.kind, "soulbound");
  });
});

/**
 * Minimal in-memory stand-in for the two collections `runCatalogMigration`
 * touches. It implements the supported `$or` unmigrated query
 * (`schemaVersion < n` OR `schemaVersion` missing) so the real runner logic is
 * exercised without a Mongo instance.
 */
function createInMemoryCatalogDb(seedRecords) {
  const materials = seedRecords.map((record) => ({ ...record }));
  const checkpoints = new Map();

  const matchesUnmigratedQuery = (doc, query) => {
    if (!query?.$or) return true;
    return query.$or.some((clause) => {
      const versionClause = clause.schemaVersion;
      if (versionClause && typeof versionClause === "object") {
        if ("$lt" in versionClause) {
          return (
            typeof doc.schemaVersion === "number" &&
            doc.schemaVersion < versionClause.$lt
          );
        }
        if ("$exists" in versionClause) {
          return doc.schemaVersion === undefined;
        }
      }
      return false;
    });
  };

  return {
    _materials: materials,
    collection(name) {
      if (name === "materials") {
        return {
          find(query) {
            let results = materials.filter((doc) =>
              matchesUnmigratedQuery(doc, query)
            );
            if (query?._id?.$gt !== undefined) {
              results = results.filter(
                (doc) => String(doc._id) > String(query._id.$gt)
              );
            }
            return {
              sort: () => ({
                limit: (limit) => ({
                  toArray: async () => results.slice(0, limit),
                }),
              }),
            };
          },
          async countDocuments(query) {
            return materials.filter((doc) =>
              matchesUnmigratedQuery(doc, query)
            ).length;
          },
          async replaceOne(filter, replacement) {
            const index = materials.findIndex((doc) => doc._id === filter._id);
            if (index !== -1) materials[index] = replacement;
          },
        };
      }
      if (name === "migration_checkpoints") {
        return {
          async findOne(filter) {
            return checkpoints.get(filter._id) || null;
          },
          async updateOne(filter, update) {
            checkpoints.set(filter._id, {
              ...(checkpoints.get(filter._id) || {}),
              ...(update.$set || {}),
            });
          },
          async deleteOne(filter) {
            checkpoints.delete(filter._id);
          },
        };
      }
      throw new Error(`Unexpected collection in mock db: ${name}`);
    },
  };
}
