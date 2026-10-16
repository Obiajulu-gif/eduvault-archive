import { describe, expect, it } from "vitest";
import { paginateRecords, sortRecords, STATUS_PRECEDENCE } from "../sortContract.js";

function makeRecord(id, { status, createdAt, isDeleted = false } = {}) {
  return {
    _id: id,
    title: `Record ${id}`,
    status,
    createdAt: createdAt ? new Date(createdAt) : undefined,
    isDeleted,
  };
}

describe("sort contract", () => {
  it("sorts mixed statuses by precedence: active first, deleted last", () => {
    const records = [
      makeRecord("a", { status: "archived", createdAt: "2024-01-01" }),
      makeRecord("b", { status: "published", createdAt: "2024-01-02" }),
      makeRecord("c", { status: "pending", createdAt: "2024-01-03" }),
      makeRecord("d", { status: "published", createdAt: "2024-01-04" }),
      makeRecord("e", { status: "draft", createdAt: "2024-01-05" }),
    ];
    const sorted = sortRecords(records);
    expect(sorted.map((r) => r._id)).toEqual(["d", "b", "e", "c", "a"]);
  });

  it("uses ID as tie-breaker when timestamps are identical", () => {
    const records = [
      makeRecord("z", { status: "published", createdAt: "2024-01-01T00:00:00Z" }),
      makeRecord("a", { status: "published", createdAt: "2024-01-01T00:00:00Z" }),
      makeRecord("m", { status: "published", createdAt: "2024-01-01T00:00:00Z" }),
    ];
    const sorted = sortRecords(records);
    expect(sorted.map((r) => r._id)).toEqual(["a", "m", "z"]);
  });

  it("produces stable ordering across repeated queries", () => {
    const records = [
      makeRecord("b", { status: "published", createdAt: "2024-01-01" }),
      makeRecord("a", { status: "published", createdAt: "2024-01-01" }),
      makeRecord("c", { status: "pending", createdAt: "2024-01-02" }),
      makeRecord("d", { status: "published", createdAt: "2024-01-03" }),
    ];
    const first = sortRecords(records).map((r) => r._id);
    const second = sortRecords(records).map((r) => r._id);
    const third = sortRecords([...records].reverse()).map((r) => r._id);
    expect(first).toEqual(second);
    expect(first).toEqual(third);
  });

  it("sorts soft-deleted records last regardless of status", () => {
    const records = [
      makeRecord("a", { status: "published", createdAt: "2024-01-01", isDeleted: true }),
      makeRecord("b", { status: "published", createdAt: "2024-01-02" }),
      makeRecord("c", { status: "archived", createdAt: "2024-01-03" }),
    ];
    const sorted = sortRecords(records);
    expect(sorted.map((r) => r._id)).toEqual(["b", "c", "a"]);
  });

  it("sorts newest first by default and oldest first when ascending", () => {
    const records = [
      makeRecord("a", { status: "published", createdAt: "2024-01-01" }),
      makeRecord("b", { status: "published", createdAt: "2024-01-03" }),
      makeRecord("c", { status: "published", createdAt: "2024-01-02" }),
    ];
    expect(sortRecords(records).map((r) => r._id)).toEqual(["b", "c", "a"]);
    expect(sortRecords(records, { descending: false }).map((r) => r._id)).toEqual(["a", "c", "b"]);
  });

  it("handles records with missing timestamps gracefully", () => {
    const records = [
      makeRecord("a", { status: "published" }),
      makeRecord("b", { status: "published", createdAt: "2024-01-01" }),
    ];
    const sorted = sortRecords(records);
    expect(sorted[0]._id).toBe("b");
  });

  it("does not mutate the input array", () => {
    const records = [
      makeRecord("b", { status: "published", createdAt: "2024-01-01" }),
      makeRecord("a", { status: "published", createdAt: "2024-01-01" }),
    ];
    const original = [...records];
    sortRecords(records);
    expect(records).toEqual(original);
  });

  it("supports custom status precedence maps", () => {
    const records = [
      makeRecord("a", { status: "custom_b", createdAt: "2024-01-01" }),
      makeRecord("b", { status: "custom_a", createdAt: "2024-01-01" }),
    ];
    const sorted = sortRecords(records, {
      statusPrecedence: { custom_a: 0, custom_b: 1 },
    });
    expect(sorted.map((r) => r._id)).toEqual(["b", "a"]);
  });
});

describe("pagination with sort contract", () => {
  it("paginates sorted results with stable page boundaries", () => {
    const records = Array.from({ length: 25 }, (_, i) =>
      makeRecord(`id_${String(i).padStart(2, "0")}`, {
        status: i % 3 === 0 ? "pending" : "published",
        createdAt: `2024-01-${String((i % 28) + 1).padStart(2, "0")}`,
      })
    );

    const page1 = paginateRecords(records, { page: 1, pageSize: 10 });
    const page2 = paginateRecords(records, { page: 2, pageSize: 10 });
    const page3 = paginateRecords(records, { page: 3, pageSize: 10 });

    expect(page1.items).toHaveLength(10);
    expect(page2.items).toHaveLength(10);
    expect(page3.items).toHaveLength(5);
    expect(page1.total).toBe(25);
    expect(page1.totalPages).toBe(3);

    // No overlap between pages
    const page1Ids = new Set(page1.items.map((r) => r._id));
    const page2Ids = new Set(page2.items.map((r) => r._id));
    for (const id of page1Ids) {
      expect(page2Ids.has(id)).toBe(false);
    }
  });

  it("produces identical pagination across repeated calls", () => {
    const records = Array.from({ length: 15 }, (_, i) =>
      makeRecord(`id_${i}`, {
        status: i % 2 === 0 ? "published" : "pending",
        createdAt: "2024-01-01T00:00:00Z",
      })
    );

    const first = paginateRecords(records, { page: 1, pageSize: 5 });
    const second = paginateRecords(records, { page: 1, pageSize: 5 });
    expect(first.items.map((r) => r._id)).toEqual(second.items.map((r) => r._id));
  });

  it("handles filtered lists deterministically", () => {
    const records = [
      makeRecord("a", { status: "published", createdAt: "2024-01-01" }),
      makeRecord("b", { status: "pending", createdAt: "2024-01-02" }),
      makeRecord("c", { status: "published", createdAt: "2024-01-03" }),
      makeRecord("d", { status: "archived", createdAt: "2024-01-04" }),
    ];
    const filtered = records.filter((r) => r.status !== "archived");
    const sorted = sortRecords(filtered);
    expect(sorted.map((r) => r._id)).toEqual(["c", "a", "b"]);
  });

  it("handles permission-limited results (subset of records)", () => {
    const allRecords = [
      makeRecord("a", { status: "published", createdAt: "2024-01-01" }),
      makeRecord("b", { status: "published", createdAt: "2024-01-02" }),
      makeRecord("c", { status: "published", createdAt: "2024-01-03" }),
      makeRecord("d", { status: "published", createdAt: "2024-01-04" }),
    ];
    // Simulate permission filtering: only records b and d are visible
    const visible = allRecords.filter((r) => ["b", "d"].includes(r._id));
    const sorted = sortRecords(visible);
    expect(sorted.map((r) => r._id)).toEqual(["d", "b"]);
  });

  it("clamps page numbers to valid range", () => {
    const records = [makeRecord("a", { status: "published", createdAt: "2024-01-01" })];
    const result = paginateRecords(records, { page: 99, pageSize: 10 });
    expect(result.page).toBe(1);
    expect(result.items).toHaveLength(1);
  });
});

describe("status precedence", () => {
  it("defines a complete precedence map", () => {
    expect(STATUS_PRECEDENCE.published).toBe(0);
    expect(STATUS_PRECEDENCE.pending).toBe(1);
    expect(STATUS_PRECEDENCE.suspended).toBe(2);
    expect(STATUS_PRECEDENCE.archived).toBe(3);
    expect(STATUS_PRECEDENCE.deleted).toBe(4);
  });
});
