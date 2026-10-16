import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  API_SCHEMA_HEADER,
  UnsupportedSchemaVersionError,
  registerRecordSchema,
  getRecordSchema,
  listRecordSchemas,
  normalizeSchemaVersion,
  readRecord,
  writeRecord,
  negotiateSchemaVersion,
  schemaResponseHeaders,
} from "../../src/lib/backend/schemaCompat.js";
import { CURRENT_CATALOG_VERSION } from "../../src/lib/migrations/catalogMigrationFramework.js";

// A synthetic collection whose migrations are trivial and independent of the
// catalog, so the generic engine is exercised rather than just the materials
// registration.
registerRecordSchema("widgets", {
  collection: "widgets",
  min: 1,
  latest: 2,
  migrations: {
    2: {
      up: (doc) => ({ ...doc, schemaVersion: 2, label: `${doc.name}:v2` }),
      down: (doc) => {
        const copy = { ...doc };
        delete copy.label;
        copy.schemaVersion = 1;
        return copy;
      },
      validate: (doc) => doc?.schemaVersion === 2 && typeof doc.label === "string",
    },
  },
});

function requestWithHeader(value) {
  return { headers: { get: (name) => (name.toLowerCase() === API_SCHEMA_HEADER ? value : null) } };
}

describe("legacy record reads (#803)", () => {
  test("an unversioned material is upgraded to the latest schema shape", () => {
    const legacy = { _id: "m1", title: "Legacy notes", price: 20, category: "Computer Science" };
    const read = readRecord("materials", legacy);

    assert.equal(read.schemaVersion, CURRENT_CATALOG_VERSION);
    assert.equal(read.pricingTier, "premium");
    assert.equal(read.sorobanEntitlementConfig.tokenStandard, "SEP-0041");
    assert.equal(read.rightsMetadata.educationalOnly, true);
    assert.equal(read.title, "Legacy notes");
  });

  test("a versioned record can be read back at an older, still-supported version", () => {
    const v2 = readRecord("materials", { _id: "m2", title: "New", price: 5 });
    const v1 = readRecord("materials", v2, { targetVersion: 1 });

    assert.equal(v1.schemaVersion, 1);
    assert.equal(v1.pricingTier, undefined);
    assert.equal(v1.title, "New");
  });

  test("a synthetic collection follows the same read contract", () => {
    assert.deepEqual(readRecord("widgets", { name: "alpha" }), { name: "alpha", schemaVersion: 2, label: "alpha:v2" });
  });

  test("reading does not mutate the stored document", () => {
    const legacy = { title: "Untouched", price: 1 };
    readRecord("materials", legacy);
    assert.equal(legacy.schemaVersion, undefined);
    assert.equal(legacy.pricingTier, undefined);
  });
});

describe("new writes (#803)", () => {
  test("a new write is stamped with the latest schema", () => {
    const written = writeRecord("widgets", { name: "beta" });
    assert.equal(written.schemaVersion, 2);
    assert.equal(written.label, "beta:v2");
  });

  test("an older client can still write the version it knows", () => {
    const written = writeRecord("widgets", { name: "beta" }, { version: 1 });
    assert.equal(written.schemaVersion, 1);
    assert.equal(written.label, undefined);
  });

  test("a legacy payload is transformed up to the requested version", () => {
    const written = writeRecord("widgets", { name: "gamma", schemaVersion: 1 });
    assert.equal(written.schemaVersion, 2);
    assert.equal(written.label, "gamma:v2");
  });

  test("catalog writes receive the current schema and required metadata", () => {
    const written = writeRecord("materials", { title: "Starter", price: 0 });
    assert.equal(written.schemaVersion, CURRENT_CATALOG_VERSION);
    assert.equal(written.pricingTier, "free");
    assert.equal(written.rightsMetadata.educationalOnly, true);
  });
});

describe("unsupported versions (#803)", () => {
  test("a record written by a newer server is rejected, not misread", () => {
    assert.throws(
      () => readRecord("widgets", { name: "future", schemaVersion: 9 }),
      (err) => err instanceof UnsupportedSchemaVersionError && err.collection === "widgets"
    );
  });

  test("writing a version the server does not know is rejected", () => {
    assert.throws(
      () => writeRecord("widgets", { name: "bad" }, { version: 3 }),
      UnsupportedSchemaVersionError
    );
  });

  test("reading at an unsupported target version is rejected", () => {
    assert.throws(() => readRecord("materials", { title: "x" }, { targetVersion: 0 }), UnsupportedSchemaVersionError);
    assert.throws(() => readRecord("materials", { title: "x" }, { targetVersion: 99 }), UnsupportedSchemaVersionError);
  });

  test("an unknown collection and a non-numeric version are rejected", () => {
    assert.throws(() => readRecord("does-not-exist", {}), /Unknown record schema/);
    assert.throws(() => normalizeSchemaVersion("nope", { collection: "widgets" }), UnsupportedSchemaVersionError);
  });

  test("errors carry a 400 status and the supported range", () => {
    const schema = getRecordSchema("widgets");
    const error = new UnsupportedSchemaVersionError("widgets", 99, schema);
    assert.equal(error.status, 400);
    assert.equal(error.latest, 2);
    assert.match(error.message, /supported: 1-2/);
  });
});

describe("API version negotiation (#803)", () => {
  test("no header means the latest shape", () => {
    const negotiation = negotiateSchemaVersion(requestWithHeader(null), "materials");
    assert.equal(negotiation.version, CURRENT_CATALOG_VERSION);
    assert.equal(negotiation.source, "default");
    assert.equal(negotiation.deprecated, false);
  });

  test("an older header is served and marked deprecated", () => {
    const negotiation = negotiateSchemaVersion(requestWithHeader("1"), "materials");
    assert.equal(negotiation.version, 1);
    assert.equal(negotiation.deprecated, true);
    assert.equal(negotiation.requested, 1);
  });

  test("an unsupported header is a 400", () => {
    assert.throws(() => negotiateSchemaVersion(requestWithHeader("99"), "materials"), UnsupportedSchemaVersionError);
    assert.throws(() => negotiateSchemaVersion(requestWithHeader("abc"), "materials"), UnsupportedSchemaVersionError);
  });

  test("response headers advertise the served and latest versions", () => {
    assert.deepEqual(schemaResponseHeaders("materials", 1), {
      "X-Schema-Version": "1",
      "X-Schema-Latest": String(CURRENT_CATALOG_VERSION),
      "X-Schema-Deprecated": "true",
    });
    assert.equal(schemaResponseHeaders("materials", CURRENT_CATALOG_VERSION)["X-Schema-Deprecated"], "false");
  });

  test("registered schemas are discoverable", () => {
    const collections = listRecordSchemas().map((schema) => schema.collection);
    assert.ok(collections.includes("materials"));
    assert.ok(collections.includes("widgets"));
  });
});
