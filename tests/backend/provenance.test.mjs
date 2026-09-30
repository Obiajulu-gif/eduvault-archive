import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  PROVENANCE_SCHEMA_VERSION,
  PROVENANCE_KINDS,
  TRANSFORM_VERSIONS,
  buildImportProvenance,
  buildDerivedProvenance,
  recordProvenanceRevision,
  traceProvenance,
  exportProvenance,
  summarizeProvenance,
  provenanceToCsv,
} from "../../src/lib/backend/provenance.js";

const NOW = new Date("2026-09-30T12:00:00.000Z");

describe("import provenance (#888)", () => {
  test("captures source, import batch, transform version, and actor", () => {
    const provenance = buildImportProvenance({
      importBatchId: "batch-1",
      format: "csv",
      sourceName: "sis-export.csv",
      recordIndex: 3,
      externalId: "sis-1042",
      actorAddress: "0xabc",
      actorUserId: "user-1",
      now: NOW,
    });

    assert.equal(provenance.schemaVersion, PROVENANCE_SCHEMA_VERSION);
    assert.equal(provenance.kind, PROVENANCE_KINDS.IMPORT);
    assert.equal(provenance.origin.importBatchId, "batch-1");
    assert.equal(provenance.origin.format, "csv");
    assert.equal(provenance.origin.name, "sis-export.csv");
    assert.equal(provenance.origin.recordIndex, 3);
    assert.equal(provenance.origin.externalId, "sis-1042");
    assert.equal(provenance.transform.version, TRANSFORM_VERSIONS.import);
    assert.equal(provenance.actor.walletAddress, "0xabc");
    assert.equal(provenance.actor.userId, "user-1");
    assert.equal(provenance.recordedAt, NOW.toISOString());
    assert.deepEqual(provenance.revisions, []);
  });

  test("requires an import batch id so a record is always traceable to a batch", () => {
    assert.throws(() => buildImportProvenance({}), /importBatchId/);
  });
});

describe("transform provenance", () => {
  test("records the transform version the pipeline used", () => {
    const v2 = buildImportProvenance({ importBatchId: "b", transformVersion: "import@2", now: NOW });
    assert.equal(v2.transform.version, "import@2");
    assert.notEqual(v2.transform.version, TRANSFORM_VERSIONS.import);
  });

  test("derived records default to the derived transform version", () => {
    const derived = buildDerivedProvenance({ sourceMaterialId: "m1", now: NOW });
    assert.equal(derived.kind, PROVENANCE_KINDS.DERIVED);
    assert.equal(derived.transform.version, TRANSFORM_VERSIONS.derived);
    assert.equal(derived.origin.relation, "derived");
    assert.throws(() => buildDerivedProvenance({}), /sourceMaterialId/);
  });
});

describe("update provenance", () => {
  test("preserves the origin and appends a revision", () => {
    const origin = buildImportProvenance({
      importBatchId: "batch-1",
      sourceName: "sis.csv",
      externalId: "sis-1",
      actorAddress: "0xabc",
      now: NOW,
    });

    const edited = recordProvenanceRevision(origin, {
      actorAddress: "0xdef",
      changedFields: ["title", "price", "title"],
      source: "creator",
      now: new Date("2026-10-01T09:00:00.000Z"),
    });

    assert.equal(edited.origin.importBatchId, "batch-1");
    assert.equal(edited.origin.externalId, "sis-1");
    assert.equal(edited.recordedAt, NOW.toISOString());
    assert.equal(edited.revisions.length, 1);
    assert.equal(edited.revisions[0].actor.walletAddress, "0xdef");
    // Duplicate field entries collapse to one.
    assert.deepEqual(edited.revisions[0].changedFields, ["title", "price"]);
  });

  test("passing no provenance returns it unchanged instead of throwing", () => {
    assert.equal(recordProvenanceRevision(null, { actorAddress: "0x1" }), null);
  });
});

describe("deleted source tracing", () => {
  test("flags a missing source without throwing", () => {
    const derived = buildDerivedProvenance({ sourceMaterialId: "gone-1", sourceExternalId: "sis-9", now: NOW });
    const trace = traceProvenance(derived, { resolveSource: () => null });

    assert.equal(trace.sourceDeleted, true);
    assert.equal(trace.depth, 1);
    assert.equal(trace.chain[0].exists, false);
    assert.equal(trace.chain[0].deleted, false);
  });

  test("flags a soft-deleted source as deleted", () => {
    const derived = buildDerivedProvenance({ sourceMaterialId: "m1", now: NOW });
    const trace = traceProvenance(derived, {
      resolveSource: (id) => (id === "m1" ? { _id: "m1", isDeleted: true, provenance: null } : null),
    });

    assert.equal(trace.sourceDeleted, true);
    assert.equal(trace.chain[0].deleted, true);
    assert.equal(trace.chain[0].exists, false);
  });

  test("walks a multi-hop chain back to the first source", () => {
    const root = buildImportProvenance({ importBatchId: "batch-1", externalId: "root", now: NOW });
    const middle = buildDerivedProvenance({ sourceMaterialId: "m0", now: NOW });
    const leaf = buildDerivedProvenance({ sourceMaterialId: "m1", now: NOW });

    const docs = {
      m1: { _id: "m1", externalId: "mid", provenance: middle },
      m0: { _id: "m0", externalId: "root", provenance: root },
    };

    const trace = traceProvenance(leaf, { resolveSource: (id) => docs[id] || null });
    assert.equal(trace.sourceDeleted, false);
    assert.equal(trace.depth, 2);
    assert.deepEqual(trace.chain.map((c) => c.materialId), ["m1", "m0"]);
  });

  test("detects a provenance cycle instead of looping forever", () => {
    const a = buildDerivedProvenance({ sourceMaterialId: "b", now: NOW });
    const b = buildDerivedProvenance({ sourceMaterialId: "a", now: NOW });
    const docs = { a: { _id: "a", provenance: a }, b: { _id: "b", provenance: b } };

    const trace = traceProvenance(a, { resolveSource: (id) => docs[id] || null });
    assert.equal(trace.broken, true);
  });

  test("an import record has an empty chain", () => {
    const trace = traceProvenance(buildImportProvenance({ importBatchId: "b" }));
    assert.deepEqual(trace, { chain: [], sourceDeleted: false, depth: 0, broken: false });
  });
});

describe("provenance export", () => {
  const imported = {
    _id: "m1",
    title: "Imported notes",
    externalId: "sis-1",
    provenance: recordProvenanceRevision(
      buildImportProvenance({ importBatchId: "batch-1", externalId: "sis-1", actorAddress: "0xabc", now: NOW }),
      { actorAddress: "0xdef", changedFields: ["price"], now: NOW }
    ),
  };
  const derived = {
    _id: "m2",
    title: "Derived adaptation",
    provenance: buildDerivedProvenance({ sourceMaterialId: "gone-1", now: NOW }),
  };
  const native = { _id: "m3", title: "Hand uploaded" };

  test("flattens provenance rows for maintainers", () => {
    const traces = { m2: traceProvenance(derived.provenance, { resolveSource: () => null }) };
    const rows = exportProvenance([imported, derived, native], { traces });

    const [first, second, third] = rows;
    assert.equal(first.provenanceKind, "import");
    assert.equal(first.importBatchId, "batch-1");
    assert.equal(first.transformVersion, TRANSFORM_VERSIONS.import);
    assert.equal(first.revisionCount, 1);
    assert.equal(first.sourceExternalId, "sis-1");

    assert.equal(second.provenanceKind, "derived");
    assert.equal(second.sourceMaterialId, "gone-1");
    assert.equal(second.sourceDeleted, true);

    assert.equal(third.provenanceKind, "none");
    assert.equal(third.sourceDeleted, null);
  });

  test("summarizes counts by kind and flags deleted sources", () => {
    const traces = { m2: traceProvenance(derived.provenance, { resolveSource: () => null }) };
    const summary = summarizeProvenance(exportProvenance([imported, derived, native], { traces }));

    assert.deepEqual(summary, {
      total: 3,
      imported: 1,
      derived: 1,
      native: 0,
      untracked: 1,
      sourcesDeleted: 1,
      revisions: 1,
    });
  });

  test("serializes to CSV with escaped cells", () => {
    const rows = exportProvenance([imported]);
    const csv = provenanceToCsv(rows);
    const [header, line] = csv.split("\n");
    assert.match(header, /^materialId,title,/);
    assert.match(line, /^m1,Imported notes,/);
  });
});
