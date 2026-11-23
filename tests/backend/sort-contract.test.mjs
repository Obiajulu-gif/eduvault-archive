import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STATUS_PRECEDENCE,
  EVENT_STATUS_RANK,
  createRecordComparator,
  createEventComparator,
  sortRecords,
  sortEvents,
  paginateRecords,
  pageAfter,
  verifyOrdering,
} from "../../src/lib/backend/sortContract.js";

function makeRecord(id, { status, createdAt, isDeleted = false, extra } = {}) {
  return {
    _id: id,
    title: `Record ${id}`,
    status,
    createdAt: createdAt ? new Date(createdAt) : undefined,
    isDeleted,
    extra,
  };
}

function makeEvent(id, { status, timestamp, sequence } = {}) {
  return {
    eventId: id,
    status,
    timestamp: timestamp ? new Date(timestamp) : undefined,
    sequence,
  };
}

test("sortRecords sorts mixed statuses by precedence: active first, deleted last", () => {
  const records = [
    makeRecord("a", { status: "archived", createdAt: "2024-01-01" }),
    makeRecord("b", { status: "published", createdAt: "2024-01-02" }),
    makeRecord("c", { status: "pending", createdAt: "2024-01-03" }),
    makeRecord("d", { status: "published", createdAt: "2024-01-04" }),
    makeRecord("e", { status: "draft", createdAt: "2024-01-05" }),
  ];

  const sorted = sortRecords(records);
  assert.deepEqual(sorted.map((r) => r._id), ["d", "b", "e", "c", "a"]);
});

test("sortRecords uses record ID as deterministic tie-breaker when status and timestamp match", () => {
  const records = [
    makeRecord("z", { status: "published", createdAt: "2024-01-01T00:00:00Z" }),
    makeRecord("a", { status: "published", createdAt: "2024-01-01T00:00:00Z" }),
    makeRecord("m", { status: "published", createdAt: "2024-01-01T00:00:00Z" }),
  ];

  const sorted = sortRecords(records);
  assert.deepEqual(sorted.map((r) => r._id), ["a", "m", "z"]);
});

test("sortRecords produces stable ordering across repeated evaluations and reverse inputs", () => {
  const records = [
    makeRecord("b", { status: "published", createdAt: "2024-01-01" }),
    makeRecord("a", { status: "published", createdAt: "2024-01-01" }),
    makeRecord("c", { status: "pending", createdAt: "2024-01-02" }),
    makeRecord("d", { status: "published", createdAt: "2024-01-03" }),
  ];

  const first = sortRecords(records).map((r) => r._id);
  const second = sortRecords(records).map((r) => r._id);
  const third = sortRecords([...records].reverse()).map((r) => r._id);

  assert.deepEqual(first, second);
  assert.deepEqual(first, third);
});

test("sortRecords handles soft-deleted records and missing timestamps gracefully", () => {
  const records = [
    makeRecord("del", { status: "published", createdAt: "2024-01-10", isDeleted: true }),
    makeRecord("valid", { status: "published", createdAt: "2024-01-01" }),
    makeRecord("no-time", { status: "published" }),
  ];

  const sorted = sortRecords(records);
  // Valid active with timestamp comes first, active with missing timestamp second, deleted last
  assert.deepEqual(sorted.map((r) => r._id), ["valid", "no-time", "del"]);
});

test("sortRecords does not mutate input array and respects descending flag", () => {
  const records = [
    makeRecord("a", { status: "published", createdAt: "2024-01-01" }),
    makeRecord("b", { status: "published", createdAt: "2024-01-03" }),
    makeRecord("c", { status: "published", createdAt: "2024-01-02" }),
  ];

  const copy = [...records];
  const desc = sortRecords(records, { descending: true });
  const asc = sortRecords(records, { descending: false });

  assert.deepEqual(records, copy);
  assert.deepEqual(desc.map((r) => r._id), ["b", "c", "a"]);
  assert.deepEqual(asc.map((r) => r._id), ["a", "c", "b"]);
});

test("sortEvents orders timeline by timestamp, monotonic sequence, lifecycle rank, and ID", () => {
  const events = [
    makeEvent("ev-compensate", { status: "refunded", timestamp: "2024-01-01T10:00:00Z", sequence: 1 }),
    makeEvent("ev-terminal", { status: "completed", timestamp: "2024-01-01T10:00:00Z", sequence: 1 }),
    makeEvent("ev-flight", { status: "processing", timestamp: "2024-01-01T10:00:00Z", sequence: 1 }),
    makeEvent("ev-start", { status: "requested", timestamp: "2024-01-01T10:00:00Z", sequence: 1 }),
    makeEvent("ev-next-seq", { status: "requested", timestamp: "2024-01-01T10:00:00Z", sequence: 2 }),
    makeEvent("ev-earlier", { status: "created", timestamp: "2024-01-01T09:00:00Z", sequence: 1 }),
  ];

  const sorted = sortEvents(events);

  // Expected chronological progression:
  // 1. ev-earlier (earlier timestamp)
  // 2. ev-start (same timestamp, sequence 1, lifecycle rank 0: requested)
  // 3. ev-flight (same timestamp, sequence 1, lifecycle rank 1: processing)
  // 4. ev-terminal (same timestamp, sequence 1, lifecycle rank 2: completed)
  // 5. ev-compensate (same timestamp, sequence 1, lifecycle rank 3: refunded)
  // 6. ev-next-seq (same timestamp, sequence 2)
  assert.deepEqual(sorted.map((e) => e.eventId), [
    "ev-earlier",
    "ev-start",
    "ev-flight",
    "ev-terminal",
    "ev-compensate",
    "ev-next-seq",
  ]);
});

test("paginateRecords produces stable page boundaries with no overlaps or missing items", () => {
  const records = Array.from({ length: 25 }, (_, i) =>
    makeRecord(`id_${String(i).padStart(2, "0")}`, {
      status: i % 3 === 0 ? "pending" : "published",
      createdAt: `2024-01-${String((i % 28) + 1).padStart(2, "0")}`,
    })
  );

  const p1 = paginateRecords(records, { page: 1, pageSize: 10 });
  const p2 = paginateRecords(records, { page: 2, pageSize: 10 });
  const p3 = paginateRecords(records, { page: 3, pageSize: 10 });

  assert.equal(p1.items.length, 10);
  assert.equal(p2.items.length, 10);
  assert.equal(p3.items.length, 5);
  assert.equal(p1.total, 25);
  assert.equal(p1.totalPages, 3);

  const seen = new Set();
  for (const item of [...p1.items, ...p2.items, ...p3.items]) {
    assert.equal(seen.has(item._id), false, "Pages must not duplicate items");
    seen.add(item._id);
  }
  assert.equal(seen.size, 25);
});

test("pageAfter keyset paging provides retry-safe pagination resilient to head insertions", () => {
  const records = [
    makeRecord("m1", { status: "published", createdAt: "2024-01-05" }),
    makeRecord("m2", { status: "published", createdAt: "2024-01-04" }),
    makeRecord("m3", { status: "published", createdAt: "2024-01-03" }),
    makeRecord("m4", { status: "published", createdAt: "2024-01-02" }),
    makeRecord("m5", { status: "published", createdAt: "2024-01-01" }),
  ];

  // First page: limit 2
  const page1 = pageAfter(records, { limit: 2 });
  assert.deepEqual(page1.items.map((r) => r._id), ["m1", "m2"]);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.nextAfter._id, "m2");

  // Client requests page 2 using after: page1.nextAfter
  const page2 = pageAfter(records, { after: page1.nextAfter, limit: 2 });
  assert.deepEqual(page2.items.map((r) => r._id), ["m3", "m4"]);
  assert.equal(page2.hasMore, true);

  // Now simulate a retry scenario where a new record was inserted at the head
  const updatedRecords = [
    makeRecord("m0", { status: "published", createdAt: "2024-01-06" }), // newly inserted at top
    ...records,
  ];

  // When client retries page 2 using after: "m2", it continues exactly from m3 without duplicates or skips!
  const retriedPage2 = pageAfter(updatedRecords, { after: page1.nextAfter, limit: 2 });
  assert.deepEqual(retriedPage2.items.map((r) => r._id), ["m3", "m4"]);
});

test("authorization filtering with isVisible preserves deterministic relative ordering", () => {
  const records = [
    makeRecord("r1", { status: "published", createdAt: "2024-01-01", extra: { department: "finance" } }),
    makeRecord("r2", { status: "published", createdAt: "2024-01-02", extra: { department: "engineering" } }),
    makeRecord("r3", { status: "published", createdAt: "2024-01-03", extra: { department: "finance" } }),
    makeRecord("r4", { status: "published", createdAt: "2024-01-04", extra: { department: "engineering" } }),
  ];

  // Filter for finance only
  const financeOnly = (r) => r.extra?.department === "finance";
  const sortedFinance = sortRecords(records, { isVisible: financeOnly });

  assert.deepEqual(sortedFinance.map((r) => r._id), ["r3", "r1"]);

  // Relative ordering of r3 and r1 is identical in full list
  const fullSorted = sortRecords(records);
  const r3Index = fullSorted.findIndex((r) => r._id === "r3");
  const r1Index = fullSorted.findIndex((r) => r._id === "r1");
  assert.ok(r3Index < r1Index, "Relative order between permitted records must be preserved");
});

test("verifyOrdering validates compliant lists and detects out-of-order or duplicate items", () => {
  const validRecords = [
    makeRecord("a", { status: "published", createdAt: "2024-01-02" }),
    makeRecord("b", { status: "published", createdAt: "2024-01-01" }),
    makeRecord("c", { status: "archived", createdAt: "2024-01-03" }),
  ];

  const checkValid = verifyOrdering(validRecords, { kind: "records" });
  assert.equal(checkValid.ok, true);
  assert.equal(checkValid.outOfOrder.length, 0);
  assert.equal(checkValid.duplicateIds.length, 0);

  // Inverted list
  const invalidOrder = [...validRecords].reverse();
  const checkInvalid = verifyOrdering(invalidOrder, { kind: "records" });
  assert.equal(checkInvalid.ok, false);
  assert.ok(checkInvalid.outOfOrder.length > 0);

  // Duplicate IDs
  const duplicates = [
    makeRecord("dup-1", { status: "published", createdAt: "2024-01-02" }),
    makeRecord("dup-1", { status: "published", createdAt: "2024-01-01" }),
  ];
  const checkDup = verifyOrdering(duplicates, { kind: "records" });
  assert.equal(checkDup.ok, false);
  assert.deepEqual(checkDup.duplicateIds, ["dup-1"]);
});
