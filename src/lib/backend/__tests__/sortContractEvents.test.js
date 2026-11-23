import { describe, expect, it } from "vitest";
import {
  createEventComparator,
  createRecordComparator,
  pageAfter,
  paginateRecords,
  sortEvents,
  sortRecords,
  verifyOrdering,
} from "../sortContract.js";

const ids = (list) => list.map((item) => item._id);

// Every permutation of a short list, to prove input order never matters.
function permutations(list) {
  if (list.length <= 1) return [list];
  return list.flatMap((item, i) =>
    permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [item, ...rest])
  );
}

const rec = (_id, status, createdAt, extra = {}) => ({ _id, status, createdAt, ...extra });
const evt = (_id, fields = {}) => ({ _id, ...fields });

describe("sortEvents", () => {
  it("orders by time ascending by default and descending on request", () => {
    const events = [
      evt("c", { occurredAt: "2026-01-03T00:00:00Z" }),
      evt("a", { occurredAt: "2026-01-01T00:00:00Z" }),
      evt("b", { occurredAt: "2026-01-02T00:00:00Z" }),
    ];
    expect(ids(sortEvents(events))).toEqual(["a", "b", "c"]);
    expect(ids(sortEvents(events, { descending: true }))).toEqual(["c", "b", "a"]);
  });

  it("breaks timestamp ties with sequence, then lifecycle rank, then id", () => {
    const at = "2026-01-01T00:00:00Z";
    const events = [
      evt("e-seq2", { occurredAt: at, sequence: 2, status: "requested" }),
      evt("e-done", { occurredAt: at, sequence: 1, status: "completed" }),
      evt("e-start", { occurredAt: at, sequence: 1, status: "requested" }),
      evt("e-flight", { occurredAt: at, sequence: 1, status: "processing" }),
      evt("e-undo", { occurredAt: at, sequence: 1, status: "rolled_back" }),
      evt("e-b", { occurredAt: at, sequence: 1, status: "failed" }),
    ];
    // Terminal states share a rank, so completed vs failed falls through to id.
    expect(ids(sortEvents(events))).toEqual(["e-start", "e-flight", "e-b", "e-done", "e-undo", "e-seq2"]);
  });

  it("reverses time, sequence and lifecycle together when descending", () => {
    const at = "2026-01-01T00:00:00Z";
    const events = [
      evt("start", { occurredAt: at, sequence: 1, status: "requested" }),
      evt("end", { occurredAt: at, sequence: 1, status: "completed" }),
      evt("later", { occurredAt: at, sequence: 2, status: "requested" }),
    ];
    expect(ids(sortEvents(events, { descending: true }))).toEqual(["later", "end", "start"]);
  });

  it("is independent of input order for every permutation", () => {
    const at = "2026-01-01T00:00:00Z";
    const events = [
      evt("a", { occurredAt: at, sequence: 1, status: "requested" }),
      evt("b", { occurredAt: at, sequence: 1, status: "completed" }),
      evt("c", { occurredAt: at, sequence: 1, status: "failed" }),
      evt("d", { occurredAt: "2026-01-02T00:00:00Z" }),
      evt("e", {}),
    ];
    const expected = ids(sortEvents(events));
    for (const permutation of permutations(events)) {
      expect(ids(sortEvents(permutation))).toEqual(expected);
    }
  });

  it("puts events with missing or invalid timestamps last in both directions", () => {
    const events = [
      evt("none", {}),
      evt("bad", { occurredAt: "not a date" }),
      evt("ok", { occurredAt: "2026-01-01T00:00:00Z" }),
    ];
    expect(ids(sortEvents(events))).toEqual(["ok", "bad", "none"]);
    expect(ids(sortEvents(events, { descending: true }))).toEqual(["ok", "bad", "none"]);
  });

  it("accepts Date, ISO string and epoch-millisecond timestamps together", () => {
    const events = [
      evt("num", { timestamp: Date.parse("2026-01-03T00:00:00Z") }),
      evt("date", { createdAt: new Date("2026-01-01T00:00:00Z") }),
      evt("iso", { at: "2026-01-02T00:00:00Z" }),
    ];
    expect(ids(sortEvents(events))).toEqual(["date", "iso", "num"]);
  });

  it("honours an explicit timestamp field and numeric-string sequences", () => {
    const events = [
      evt("b", { logged: "2026-01-01T00:00:00Z", sequence: "10" }),
      evt("a", { logged: "2026-01-01T00:00:00Z", sequence: "9" }),
      evt("x", { occurredAt: "2025-01-01T00:00:00Z", logged: "2027-01-01T00:00:00Z" }),
    ];
    expect(ids(sortEvents(events, { timestampField: "logged" }))).toEqual(["a", "b", "x"]);
  });

  it("treats unknown, mixed-case and prototype-key statuses safely", () => {
    const at = "2026-01-01T00:00:00Z";
    const events = [
      evt("weird", { occurredAt: at, status: "constructor" }),
      evt("upper", { occurredAt: at, status: " COMPLETED " }),
      evt("start", { occurredAt: at, status: "Requested" }),
      evt("unknown", { occurredAt: at, status: "mystery" }),
    ];
    expect(ids(sortEvents(events))).toEqual(["start", "upper", "unknown", "weird"]);
  });
});

describe("hardening of the record contract", () => {
  it("sorts missing timestamps last for oldest-first lists too", () => {
    const records = [rec("none", "published"), rec("old", "published", "2024-01-01"), rec("new", "published", "2024-02-01")];
    expect(ids(sortRecords(records, { descending: false }))).toEqual(["old", "new", "none"]);
    expect(ids(sortRecords(records))).toEqual(["new", "old", "none"]);
  });

  it("matches statuses case-insensitively and ignores inherited keys", () => {
    const records = [
      rec("a", "toString", "2024-01-01"),
      rec("b", "PUBLISHED", "2024-01-01"),
      rec("c", " Pending", "2024-01-01"),
    ];
    expect(ids(sortRecords(records))).toEqual(["b", "c", "a"]);
  });

  it("is independent of input order for every permutation", () => {
    const records = [
      rec("a", "published", "2024-01-01"),
      rec("b", "published", "2024-01-01"),
      rec("c", "pending", "2024-01-01"),
      rec("d", "archived", undefined),
      rec("e", "published", "2024-01-01", { isDeleted: true }),
    ];
    const expected = ids(sortRecords(records));
    for (const permutation of permutations(records)) {
      expect(ids(sortRecords(permutation))).toEqual(expected);
    }
  });

  it("survives malformed input instead of throwing", () => {
    expect(sortRecords(null)).toEqual([]);
    expect(sortEvents(undefined)).toEqual([]);
    expect(sortEvents("nope")).toEqual([]);
    expect(() => sortRecords([null, undefined, 5, rec("a", "published", "2024-01-01")])).not.toThrow();
    expect(sortRecords([null, rec("a", "published", "2024-01-01")])[0]._id).toBe("a");
    expect(() => sortEvents([null, evt("a", {})])).not.toThrow();
  });

  it("uses failureId as an identifier for aggregated failures", () => {
    const failures = [
      { failureId: "job_2", status: "unresolved", updatedAt: "2024-01-01" },
      { failureId: "job_1", status: "unresolved", updatedAt: "2024-01-01" },
    ];
    expect(sortRecords(failures, { timestampField: "updatedAt" }).map((f) => f.failureId)).toEqual(["job_1", "job_2"]);
  });
});

describe("authorization", () => {
  const all = [
    rec("a", "published", "2024-01-04"),
    rec("secret-1", "published", "2024-01-03"),
    rec("b", "pending", "2024-01-02"),
    rec("secret-2", "draft", "2024-01-01"),
    rec("c", "archived", "2024-01-05"),
  ];
  const isVisible = (r) => !r._id.startsWith("secret");

  it("paginates only visible records so totals and pages never reveal hidden ones", () => {
    const page = paginateRecords(all, { page: 1, pageSize: 2, isVisible });
    expect(page.total).toBe(3);
    expect(ids(page.items)).toEqual(["a", "b"]);
    expect(ids(paginateRecords(all, { page: 2, pageSize: 2, isVisible }).items)).toEqual(["c"]);
  });

  it("orders visible records the same as sorting just the visible subset", () => {
    const filteredFirst = ids(sortRecords(all.filter(isVisible)));
    expect(ids(paginateRecords(all, { pageSize: 50, isVisible }).items)).toEqual(filteredFirst);
    expect(ids(pageAfter(all, { limit: 50, isVisible }).items)).toEqual(filteredFirst);
  });

  it("leaves paginateRecords unchanged when no filter is given", () => {
    expect(paginateRecords(all, { pageSize: 50 }).total).toBe(5);
  });
});

describe("pageAfter (resumable paging)", () => {
  const events = Array.from({ length: 7 }, (_, i) =>
    evt(`e${i}`, { occurredAt: `2026-01-0${i + 1}T00:00:00Z`, sequence: i })
  );

  it("walks the whole list with no gaps or repeats", () => {
    const seen = [];
    let after = null;
    for (;;) {
      const page = pageAfter(events, { kind: "events", after, limit: 3 });
      seen.push(...ids(page.items));
      if (!page.hasMore) break;
      after = page.nextAfter;
    }
    expect(seen).toEqual(ids(sortEvents(events)));
  });

  it("retrying a page after a failure returns the same page", () => {
    const first = pageAfter(events, { kind: "events", limit: 3 });
    const retryA = pageAfter(events, { kind: "events", after: first.nextAfter, limit: 3 });
    const retryB = pageAfter([...events].reverse(), { kind: "events", after: first.nextAfter, limit: 3 });
    expect(ids(retryA.items)).toEqual(ids(retryB.items));
    expect(ids(retryA.items)).toEqual(["e3", "e4", "e5"]);
  });

  it("neither skips nor repeats when items arrive or vanish between pages", () => {
    const first = pageAfter(events, { kind: "events", limit: 3 });
    const changed = [
      evt("e-early", { occurredAt: "2025-12-01T00:00:00Z" }), // inserted before the cursor
      ...events.filter((e) => e._id !== "e1"), // removed from the already-served part
    ];
    const second = pageAfter(changed, { kind: "events", after: first.nextAfter, limit: 3 });
    expect(ids(second.items)).toEqual(["e3", "e4", "e5"]);
  });

  it("works when the cursor item itself was deleted", () => {
    const cursor = events[2];
    const second = pageAfter(events.filter((e) => e._id !== "e2"), { kind: "events", after: cursor, limit: 2 });
    expect(ids(second.items)).toEqual(["e3", "e4"]);
  });

  it("returns an empty page past the end and for an unknown kind it throws", () => {
    const end = pageAfter(events, { kind: "events", after: events[6], limit: 3 });
    expect(end).toEqual({ items: [], nextAfter: null, hasMore: false });
    expect(() => pageAfter(events, { kind: "bogus" })).toThrow(/Unknown sort kind/);
  });

  it("pages records by their contract too", () => {
    const records = [rec("a", "published", "2024-01-03"), rec("b", "pending", "2024-01-04"), rec("c", "published", "2024-01-02")];
    const first = pageAfter(records, { limit: 2 });
    expect(ids(first.items)).toEqual(["a", "c"]);
    expect(first.hasMore).toBe(true);
    expect(ids(pageAfter(records, { after: first.nextAfter, limit: 2 }).items)).toEqual(["b"]);
  });
});

describe("verifyOrdering", () => {
  it("accepts a correctly ordered list", () => {
    const sorted = sortEvents([evt("b", { occurredAt: "2026-01-02T00:00:00Z" }), evt("a", { occurredAt: "2026-01-01T00:00:00Z" })]);
    expect(verifyOrdering(sorted, { kind: "events" })).toEqual({ ok: true, outOfOrder: [], duplicateIds: [] });
  });

  it("reports out-of-order positions and duplicate ids", () => {
    const list = [rec("b", "pending", "2024-01-01"), rec("a", "published", "2024-01-01"), rec("a", "published", "2024-01-01")];
    const result = verifyOrdering(list);
    expect(result.ok).toBe(false);
    expect(result.outOfOrder).toEqual([1]);
    expect(result.duplicateIds).toEqual(["a"]);
  });

  it("tolerates non-arrays", () => {
    expect(verifyOrdering(null).ok).toBe(true);
  });
});

describe("comparators", () => {
  it("are exposed for callers that sort in a database layer or a UI", () => {
    const compare = createRecordComparator();
    expect(compare(rec("a", "published", "2024-01-01"), rec("b", "archived", "2024-01-01"))).toBeLessThan(0);
    expect(createEventComparator()(evt("a", { occurredAt: "2026-01-01" }), evt("a", { occurredAt: "2026-01-01" }))).toBe(0);
  });
});
