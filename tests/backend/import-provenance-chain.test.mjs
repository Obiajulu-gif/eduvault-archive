import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  createProvenanceEntry,
  digestImportRecord,
  verifyProvenanceChain,
  ImportProvenanceError,
} from "../../src/lib/backend/importProvenanceChain.js";

const NOW = "2026-09-30T12:00:00.000Z";
const BATCH = "batch-1120";
const IMPORTER = "0xcreator";

const RECORDS = [
  { externalId: "sis-1", title: "Algebra", price: 2 },
  { externalId: "sis-2", title: "Geometry", price: 3 },
  { externalId: "sis-3", title: "Calculus", price: 0 },
];

function buildChain(records = RECORDS) {
  const entries = [];
  let previousEntryHash = null;
  records.forEach((record, index) => {
    const entry = createProvenanceEntry({
      seq: index + 1,
      previousEntryHash,
      record,
      importBatchId: BATCH,
      importerAddress: IMPORTER,
      recordIndex: index + 1,
      recordedAt: NOW,
      authorized: true,
    });
    entries.push(entry);
    previousEntryHash = entry.entryHash;
  });
  return entries;
}

function assertChainError(fn, code) {
  assert.throws(fn, (error) => error instanceof ImportProvenanceError && error.code === code);
}

describe("import provenance chain (#1120)", () => {
  test("normal path: a built chain verifies end to end", () => {
    const entries = buildChain();
    const result = verifyProvenanceChain(entries, RECORDS);

    assert.equal(result.valid, true);
    assert.equal(result.length, 3);
    assert.equal(result.headHash, entries[2].entryHash);
  });

  test("digest ignores key order so logically equal records match", () => {
    const a = digestImportRecord({
      record: { title: "A", price: 1 },
      importBatchId: BATCH,
      importerAddress: IMPORTER,
      recordIndex: 1,
    });
    const b = digestImportRecord({
      record: { price: 1, title: "A" },
      importBatchId: BATCH,
      importerAddress: IMPORTER,
      recordIndex: 1,
    });
    assert.equal(a.digest, b.digest);
    assert.match(a.digest, /^[0-9a-f]{64}$/);
  });

  test("failure: altered record is rejected with digest_mismatch", () => {
    const entries = buildChain();
    const tampered = RECORDS.map((record, index) =>
      index === 1 ? { ...record, price: 999 } : record
    );
    assertChainError(() => verifyProvenanceChain(entries, tampered), "digest_mismatch");
  });

  test("failure: reordered entries are rejected with sequence_gap", () => {
    const entries = buildChain();
    const reordered = [entries[1], entries[0], entries[2]];
    assertChainError(() => verifyProvenanceChain(reordered, RECORDS), "sequence_gap");
  });

  test("failure: a missing link is rejected with sequence_gap", () => {
    const entries = buildChain();
    const withGap = [entries[0], entries[2]];
    assertChainError(() => verifyProvenanceChain(withGap, [RECORDS[0], RECORDS[2]]), "sequence_gap");
  });

  test("failure: a swapped previous hash is rejected with chain_broken", () => {
    const entries = buildChain();
    const forged = { ...entries[1], previousEntryHash: "0".repeat(64) };
    assertChainError(() => verifyProvenanceChain([entries[0], forged, entries[2]], RECORDS), "chain_broken");
  });

  test("failure: a field edited without rehashing is rejected with entry_tampered", () => {
    const entries = buildChain();
    const forged = { ...entries[0], importerAddress: "0xintruder" };
    assertChainError(() => verifyProvenanceChain([forged, entries[1], entries[2]], RECORDS), "entry_tampered");
  });

  test("failure: unsupported digest algorithm is rejected explicitly", () => {
    assertChainError(
      () =>
        digestImportRecord({
          record: RECORDS[0],
          importBatchId: BATCH,
          importerAddress: IMPORTER,
          recordIndex: 1,
          algorithm: "md5",
        }),
      "unsupported_algorithm"
    );
  });

  test("failure: invalid input is rejected with invalid_input", () => {
    assertChainError(
      () => createProvenanceEntry({ seq: 1, record: RECORDS[0], importBatchId: "", importerAddress: IMPORTER, recordIndex: 1, recordedAt: NOW, authorized: true }),
      "invalid_input"
    );
    assertChainError(
      () => digestImportRecord({ record: { price: Number.NaN }, importBatchId: BATCH, importerAddress: IMPORTER, recordIndex: 1 }),
      "invalid_input"
    );
    assertChainError(
      () => createProvenanceEntry({ seq: 2, previousEntryHash: null, record: RECORDS[0], importBatchId: BATCH, importerAddress: IMPORTER, recordIndex: 1, recordedAt: NOW, authorized: true }),
      "invalid_input"
    );
  });

  test("retry: re-running the same import yields the same digest and chain head", () => {
    const first = buildChain();
    const retried = buildChain();
    assert.deepEqual(
      retried.map((entry) => entry.digest),
      first.map((entry) => entry.digest)
    );
    assert.equal(verifyProvenanceChain(retried, RECORDS).headHash, verifyProvenanceChain(first, RECORDS).headHash);
  });

  test("retry: a later recordedAt changes the entry hash but not the record digest", () => {
    const original = buildChain()[0];
    const retriedAt = createProvenanceEntry({
      seq: 1,
      previousEntryHash: null,
      record: RECORDS[0],
      importBatchId: BATCH,
      importerAddress: IMPORTER,
      recordIndex: 1,
      recordedAt: "2026-10-01T12:00:00.000Z",
      authorized: true,
    });
    assert.equal(retriedAt.digest, original.digest);
    assert.notEqual(retriedAt.entryHash, original.entryHash);
  });

  test("authorization: an unauthorized importer produces no entry", () => {
    for (const authorized of [false, undefined, "true", 1]) {
      assertChainError(
        () =>
          createProvenanceEntry({
            seq: 1,
            previousEntryHash: null,
            record: RECORDS[0],
            importBatchId: BATCH,
            importerAddress: "0xstranger",
            recordIndex: 1,
            recordedAt: NOW,
            authorized,
          }),
        "unauthorized"
      );
    }
  });
});
