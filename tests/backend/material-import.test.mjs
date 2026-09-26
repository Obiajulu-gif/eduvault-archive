import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  validateImportPayload,
  validateImportRow,
  validateImportSchema,
  ImportValidationError,
  planImport,
  publicPlanRows,
} from "../../src/lib/backend/materialImport.js";

describe("validateImportSchema", () => {
  test("accepts valid payload with records", () => {
    const result = validateImportSchema({
      records: [{ title: "Test", storageKey: "ipfs://file" }],
    });
    assert.equal(result.format, "json");
    assert.equal(result.dryRun, true);
    assert.equal(result.records.length, 1);
  });

  test("accepts items array", () => {
    const result = validateImportSchema({
      items: [{ title: "Test", storageKey: "ipfs://file" }],
    });
    assert.equal(result.records.length, 1);
  });

  test("rejects empty records", () => {
    assert.throws(
      () => validateImportSchema({ records: [] }),
      /contains no records/
    );
  });

  test("rejects missing records", () => {
    assert.throws(
      () => validateImportSchema({}),
      /must contain a 'records'/
    );
  });

  test("rejects too many records", () => {
    const records = Array.from({ length: 501 }, (_, i) => ({
      title: `Test ${i}`,
      storageKey: `ipfs://file-${i}`,
    }));
    assert.throws(
      () => validateImportSchema({ records }),
      /Maximum 500 records/
    );
  });

  test("rejects unsupported format", () => {
    assert.throws(
      () => validateImportSchema({ format: "xml", records: [{ title: "T", storageKey: "ipfs://f" }] }),
      /Unsupported import format/
    );
  });

  test("dryRun defaults to true", () => {
    const result = validateImportSchema({
      records: [{ title: "Test", storageKey: "ipfs://file" }],
    });
    assert.equal(result.dryRun, true);
  });

  test("dryRun can be set to false", () => {
    const result = validateImportSchema({
      records: [{ title: "Test", storageKey: "ipfs://file" }],
      dryRun: false,
    });
    assert.equal(result.dryRun, false);
  });
});

describe("validateImportRow", () => {
  test("validates a complete valid row", () => {
    const result = validateImportRow({
      title: "  Calculus Notes  ",
      storageKey: "ipfs://QmFile",
      price: "10",
      subject: "Math",
      level: "advanced",
    }, 0);

    assert.equal(result.valid, true);
    assert.equal(result.data.title, "Calculus Notes");
    assert.equal(result.data.price, 10);
    assert.equal(result.data.subject, "mathematics");
    assert.equal(result.data.level, "advanced");
  });

  test("rejects row without title", () => {
    const result = validateImportRow({ storageKey: "ipfs://file" }, 0);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === "title"));
  });

  test("rejects row without storageKey", () => {
    const result = validateImportRow({ title: "Test" }, 0);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === "storageKey"));
  });

  test("rejects invalid price", () => {
    const result = validateImportRow({
      title: "Test",
      storageKey: "ipfs://file",
      price: "not-a-number",
    }, 0);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === "price"));
  });

  test("rejects invalid visibility", () => {
    const result = validateImportRow({
      title: "Test",
      storageKey: "ipfs://file",
      visibility: "secret",
    }, 0);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === "visibility"));
  });

  test("rejects unknown subject", () => {
    const result = validateImportRow({
      title: "Test",
      storageKey: "ipfs://file",
      subject: "astrology",
    }, 0);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === "subject"));
  });

  test("rejects unknown category", () => {
    const result = validateImportRow({
      title: "Test",
      storageKey: "ipfs://file",
      category: "unknown-cat",
    }, 0);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === "category"));
  });

  test("rejects unknown level", () => {
    const result = validateImportRow({
      title: "Test",
      storageKey: "ipfs://file",
      level: "expert",
    }, 0);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.field === "level"));
  });

  test("accepts row with only required fields", () => {
    const result = validateImportRow({
      title: "Minimal",
      storageKey: "ipfs://file",
    }, 0);
    assert.equal(result.valid, true);
    assert.equal(result.data.title, "Minimal");
    assert.equal(result.data.visibility, "private");
  });

  test("accepts fileUrl as alternative to storageKey", () => {
    const result = validateImportRow({
      title: "Test",
      fileUrl: "ipfs://file-url",
    }, 0);
    assert.equal(result.valid, true);
    assert.equal(result.data.storageKey, "ipfs://file-url");
  });
});

describe("validateImportPayload", () => {
  test("validates multiple records", () => {
    const result = validateImportPayload({
      records: [
        { title: "Valid", storageKey: "ipfs://a" },
        { title: "", storageKey: "ipfs://b" },
        { title: "Also Valid", storageKey: "ipfs://c" },
      ],
    });

    assert.equal(result.total, 3);
    assert.equal(result.valid, 2);
    assert.equal(result.invalid, 1);
    assert.equal(result.invalidRows.length, 1);
    assert.equal(result.invalidRows[0].row, 2);
  });

  test("returns row-level errors with details", () => {
    const result = validateImportPayload({
      records: [
        { title: "Good", storageKey: "ipfs://a" },
        { title: "Bad", storageKey: "ipfs://b", price: "free", subject: "unknown" },
      ],
    });

    assert.equal(result.invalid, 1);
    assert.equal(result.invalidRows[0].row, 2);
    assert.ok(result.invalidRows[0].errors.some((e) => e.field === "price"));
    assert.ok(result.invalidRows[0].errors.some((e) => e.field === "subject"));
  });

  test("dry-run mode does not include saved records", () => {
    const result = validateImportPayload({
      records: [
        { title: "Test", storageKey: "ipfs://a" },
      ],
      dryRun: true,
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.valid, 1);
    assert.equal(result.validRecords.length, 1);
  });
});

describe("validateImportRow untrusted fields (#792)", () => {
  test("rejects javascript: and obfuscated scheme URLs", () => {
    for (const url of ["javascript:alert(1)", "java\tscript:alert(1)", " javascript:alert(1)", "//evil.example/x.png"]) {
      const result = validateImportRow({ title: "T", storageKey: "ipfs://a", coverImageUrl: url }, 0);
      assert.equal(result.valid, false, url);
      assert.equal(result.errors[0].field, "coverImageUrl");
    }
  });

  test("strips script from description", () => {
    const result = validateImportRow({ title: "T", storageKey: "ipfs://a", description: "<p>ok</p><script>alert(1)</script>" }, 0);
    assert.equal(result.valid, true);
    assert.equal(result.data.description, "<p>ok</p>");
  });
});

describe("planImport (#791)", () => {
  const plan = (records, existing) => planImport(validateImportPayload({ records }), existing);

  test("classifies create, update, skip, and error with counts", () => {
    const existing = [
      { _id: "m1", ...validateImportRow({ externalId: "ext-1", title: "One", storageKey: "ipfs://one" }, 0).data },
      { _id: "m2", ...validateImportRow({ externalId: "ext-2", title: "Two", storageKey: "ipfs://two", price: 5 }, 1).data },
    ];
    const result = plan([
      { externalId: "ext-1", title: "One", storageKey: "ipfs://one" },
      { externalId: "ext-2", title: "Two v2", storageKey: "ipfs://two", price: 5 },
      { externalId: "ext-3", title: "Three", storageKey: "ipfs://three" },
      { title: "", storageKey: "ipfs://bad" },
    ], existing);

    assert.deepEqual(result.summary, { create: 1, update: 1, skip: 1, error: 1 });
    assert.deepEqual(result.rows.map((r) => r.action), ["skip", "update", "create", "error"]);
    assert.deepEqual(result.rows[1].fields, ["title"]);
  });

  test("is idempotent: re-running an applied file yields only skips", () => {
    const records = [
      { externalId: "ext-1", title: "One", storageKey: "ipfs://one", learningOutcomes: ["a"] },
    ];
    const first = plan(records, []);
    assert.equal(first.summary.create, 1);

    const applied = [{ _id: "m1", ...first.rows[0].record }];
    const second = plan(records, applied);
    assert.deepEqual(second.summary, { create: 0, update: 0, skip: 1, error: 0 });
  });

  test("flags duplicate externalId and storageKey within one batch", () => {
    const result = plan([
      { externalId: "dup", title: "A", storageKey: "ipfs://a" },
      { externalId: "dup", title: "B", storageKey: "ipfs://b" },
      { title: "C", storageKey: "ipfs://c" },
      { title: "D", storageKey: "ipfs://c" },
    ], []);

    assert.deepEqual(result.rows.map((r) => r.action), ["create", "error", "create", "error"]);
    assert.match(result.rows[1].errors[0].message, /Duplicate of row 1/);
    assert.match(result.rows[3].errors[0].message, /Duplicate of row 3/);
  });

  test("skips rows without externalId whose storageKey is already imported", () => {
    const result = plan([{ title: "Again", storageKey: "ipfs://a" }], [{ _id: "m1", storageKey: "ipfs://a" }]);
    assert.equal(result.rows[0].action, "skip");
    assert.equal(result.rows[0].reason, "storageKey already imported");
  });

  test("publicPlanRows drops internal payloads", () => {
    const result = plan([{ externalId: "e", title: "T v2", storageKey: "ipfs://a" }], [{ _id: "m1", externalId: "e", title: "T", storageKey: "ipfs://a" }]);
    const [row] = publicPlanRows(result.rows);
    assert.equal(row.record, undefined);
    assert.equal(row.previous, undefined);
    assert.equal(row.action, "update");
  });
});
