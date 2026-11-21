import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  SCHEMA_COMPATIBILITY_MATRIX,
  checkCompatibilityCoverage,
  loadFixture,
  missingRequiredFields,
} from "../../src/lib/migrations/compatibility/matrix.js";
import {
  UnsupportedSchemaVersionError,
  getRecordSchema,
  readRecord,
  writeRecord,
} from "../../src/lib/backend/schemaCompat.js";

describe("schema migration compatibility matrix (#1119)", () => {
  test("matrix ranges match the live record schema registry", () => {
    for (const [collection, entry] of Object.entries(SCHEMA_COMPATIBILITY_MATRIX)) {
      const schema = getRecordSchema(collection);
      assert.equal(entry.min, schema.min, `${collection} min`);
      assert.equal(entry.latest, schema.latest, `${collection} latest`);
    }
  });

  test("every version has a fixture and every adjacent pair has a migration step", () => {
    assert.deepEqual(checkCompatibilityCoverage(), []);
  });

  test("fixtures validate against their declared version", () => {
    assert.deepEqual(missingRequiredFields("materials", 1, loadFixture("materials", 1)), []);
    assert.deepEqual(missingRequiredFields("materials", 2, loadFixture("materials", 2)), []);
  });

  test("normal upgrade: a v1 fixture reads as latest with the v2 fields", () => {
    const upgraded = readRecord("materials", loadFixture("materials", 1));
    assert.equal(upgraded.schemaVersion, 2);
    assert.ok(upgraded.pricingTier, "pricingTier present after upgrade");
    assert.ok(upgraded.sorobanEntitlementConfig, "sorobanEntitlementConfig present after upgrade");
    assert.ok(upgraded.rightsMetadata, "rightsMetadata present after upgrade");
  });

  test("normal downgrade: a v2 fixture pinned to v1 is readable", () => {
    assert.doesNotThrow(() => readRecord("materials", loadFixture("materials", 2), { targetVersion: 1 }));
  });

  test("failure: an unknown target version is rejected", () => {
    assert.throws(
      () => readRecord("materials", loadFixture("materials", 1), { targetVersion: 99 }),
      UnsupportedSchemaVersionError,
    );
  });

  test("failure: a document from an unknown newer version is rejected, not reinterpreted", () => {
    const future = { ...loadFixture("materials", 1), schemaVersion: 7 };
    assert.throws(() => readRecord("materials", future), UnsupportedSchemaVersionError);
  });

  test("failure: looking up a fixture for an unregistered version throws", () => {
    assert.throws(() => loadFixture("materials", 99), /no compatibility entry/);
  });

  test("failure: a v2 document missing rights metadata is reported", () => {
    const doc = loadFixture("materials", 2);
    delete doc.rightsMetadata;
    assert.deepEqual(missingRequiredFields("materials", 2, doc), ["rightsMetadata"]);
  });

  test("retry: reading the same legacy document twice is deterministic and does not mutate it", () => {
    const legacy = loadFixture("materials", 1);
    const snapshot = structuredClone(legacy);
    const first = readRecord("materials", legacy);
    const second = readRecord("materials", legacy);
    assert.deepEqual(first, second);
    assert.deepEqual(legacy, snapshot);
  });

  test("retry: writing the same legacy payload twice produces the same stored shape", () => {
    const legacy = loadFixture("materials", 1);
    assert.deepEqual(writeRecord("materials", legacy), writeRecord("materials", legacy));
  });
});
