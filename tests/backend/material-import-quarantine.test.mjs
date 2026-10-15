import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  detectQuarantineReasons,
  planImport,
  publicPlanRows,
  validateImportPayload,
} from "../../src/lib/backend/materialImport.js";

describe("detectQuarantineReasons", () => {
  test("allows ipfs, http(s) and scheme-less storage keys", () => {
    assert.deepEqual(detectQuarantineReasons("ipfs://bafybeig"), []);
    assert.deepEqual(detectQuarantineReasons("https://cdn.example.com/a.pdf"), []);
    assert.deepEqual(detectQuarantineReasons("bafybeigdyrzt5"), []);
    assert.deepEqual(detectQuarantineReasons("/files/a.pdf"), []);
  });

  test("quarantines schemes that could execute or hide content", () => {
    for (const key of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "VBScript:x"]) {
      const reasons = detectQuarantineReasons(key);
      assert.equal(reasons.length, 1, key);
      assert.equal(reasons[0].code, "unsafe_storage_scheme");
      assert.equal(reasons[0].field, "storageKey");
    }
  });
});

describe("validateImportPayload quarantine routing", () => {
  const payload = {
    records: [
      { externalId: "a-1", title: "Algebra", storageKey: "ipfs://bafy1" },
      { externalId: "a-2", title: "Hostile", storageKey: "javascript:alert(1)" },
      { externalId: "a-3", title: "Biology", storageKey: "ipfs://bafy3" },
    ],
  };

  test("a quarantined row is not an error and keeps the rest valid", () => {
    const validation = validateImportPayload(payload);
    assert.equal(validation.invalid, 0);
    assert.equal(validation.results[1].quarantineReasons.length, 1);
  });

  test("planImport holds the unsafe row out and plans the accepted rows", () => {
    const { summary, rows } = planImport(validateImportPayload(payload), []);
    assert.deepEqual(summary, { create: 2, update: 0, skip: 0, error: 0, quarantine: 1 });
    const quarantined = rows.find((r) => r.action === "quarantine");
    assert.equal(quarantined.row, 2);
    assert.equal(quarantined.record.title, "Hostile");
    assert.equal(rows.filter((r) => r.action === "create").length, 2);
  });

  test("public plan rows expose reasons without the internal record", () => {
    const { rows } = planImport(validateImportPayload(payload), []);
    const [publicRow] = publicPlanRows(rows).filter((r) => r.action === "quarantine");
    assert.equal(publicRow.reasons[0].code, "unsafe_storage_scheme");
    assert.equal("record" in publicRow, false);
  });

  test("a quarantined row never shadows a later accepted duplicate", () => {
    const { rows } = planImport(validateImportPayload({
      records: [
        { externalId: "dup", title: "First", storageKey: "javascript:x" },
        { externalId: "dup", title: "Second", storageKey: "ipfs://ok" },
      ],
    }), []);
    assert.deepEqual(rows.map((r) => r.action), ["quarantine", "create"]);
  });
});
