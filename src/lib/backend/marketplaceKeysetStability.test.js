/**
 * Executable stability checks for marketplace keyset pagination, run against an
 * in-memory collection (no Mongo needed). The page loop mirrors
 * src/app/api/market-materials/route.js: the real discovery query + cursor
 * clause, `pageSize + 1` fetch, and a cursor taken from the last returned item.
 */
import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import {
  buildMarketplaceCursorClause,
  buildMarketplaceDiscoveryQuery,
  buildMarketplaceSort,
  decodeMarketplaceCursor,
  encodeMarketplaceCursor,
} from "./marketplaceDiscovery.js";
import { mulberry32 } from "../../../test/concurrency/harness.js";

// ---- minimal Mongo semantics: equality (null matches missing), $ne, $exists, $gt, $lt, $or, $and ----
const norm = (v) => (v === undefined ? null : v instanceof Date ? v.getTime() : v instanceof ObjectId ? String(v) : v);

function matchesCondition(actual, condition) {
  const isOperatorObject =
    condition && typeof condition === "object" && !(condition instanceof Date) && !(condition instanceof ObjectId) && !(condition instanceof RegExp);
  if (!isOperatorObject) return norm(actual) === norm(condition);
  return Object.entries(condition).every(([op, value]) => {
    switch (op) {
      case "$ne":
        return norm(actual) !== norm(value);
      case "$exists":
        return (actual !== undefined) === value;
      case "$gt":
        return norm(actual) !== null && norm(actual) > norm(value);
      case "$lt":
        return norm(actual) !== null && norm(actual) < norm(value);
      default:
        throw new Error(`test matcher does not support ${op}`);
    }
  });
}

function matches(doc, query) {
  return Object.entries(query).every(([key, condition]) => {
    if (key === "$or") return condition.some((sub) => matches(doc, sub));
    if (key === "$and") return condition.every((sub) => matches(doc, sub));
    return matchesCondition(doc[key], condition);
  });
}

function compareBySort(a, b, sort) {
  for (const [field, direction] of Object.entries(sort)) {
    const x = norm(a[field]);
    const y = norm(b[field]);
    if (x === y) continue;
    if (x === null) return -direction; // nulls sort lowest
    if (y === null) return direction;
    return (x < y ? -1 : 1) * direction;
  }
  return 0;
}

// ---- fixtures ----
let idCounter = 0;
const nextId = () => new ObjectId((++idCounter).toString(16).padStart(24, "0"));
const BASE = Date.parse("2026-01-01T00:00:00Z");

function makeDoc(i, overrides = {}) {
  return {
    _id: nextId(),
    visibility: "public",
    archived: false,
    moderationStatus: "approved",
    isDeleted: false,
    creatorSuspended: false,
    quarantineState: "clean",
    createdAt: new Date(BASE + Math.floor(i / 3) * 1000), // three-way createdAt ties
    price: [5, 10, 10, 10, 20][i % 5],
    rating: i % 7 === 0 ? undefined : i % 5, // some listings have no rating yet
    likes: i % 4 === 0 ? undefined : i % 3,
    ...overrides,
  };
}

const HIDERS = [
  (d) => (d.archived = true),
  (d) => (d.isDeleted = true),
  (d) => (d.moderationStatus = "suspended"),
  (d) => (d.creatorSuspended = true),
  (d) => (d.visibility = "private"),
  (d) => (d.quarantineState = "rejected"),
];

function fetchPage(docs, { sortBy, pageSize, cursor }) {
  const query = buildMarketplaceDiscoveryQuery(new URLSearchParams());
  const sort = buildMarketplaceSort(sortBy);
  if (cursor) {
    query.$and = query.$and || [];
    query.$and.push(buildMarketplaceCursorClause(decodeMarketplaceCursor(cursor, sort), sort));
  }
  let items = docs.filter((doc) => matches(doc, query)).sort((a, b) => compareBySort(a, b, sort));
  items = items.slice(0, pageSize + 1);
  const hasNextPage = items.length > pageSize;
  if (hasNextPage) items = items.slice(0, pageSize);
  const nextCursor = hasNextPage ? encodeMarketplaceCursor(items.at(-1), sort) : null;
  return { items, hasNextPage, nextCursor, query };
}

/** Walk every page; `between(pageIndex, pageResult)` may mutate `docs` between requests. */
function traverse(docs, { sortBy = "newest", pageSize = 10, between } = {}) {
  const pages = [];
  let cursor;
  for (let guard = 0; guard < 500; guard += 1) {
    const page = fetchPage(docs, { sortBy, pageSize, cursor });
    pages.push(page);
    if (!page.hasNextPage) break;
    cursor = page.nextCursor;
    between?.(pages.length - 1, page);
  }
  return pages;
}

const ids = (pages) => pages.flatMap((p) => p.items.map((d) => String(d._id)));
const visibleNow = (docs) => {
  const query = buildMarketplaceDiscoveryQuery(new URLSearchParams());
  return docs.filter((d) => matches(d, query));
};

describe("keyset pagination: full traversal", () => {
  it.each(["newest", "price_asc", "price_desc", "rating_desc", "popular"])(
    "%s visits every listing exactly once in sort order, including ties and missing sort fields",
    (sortBy) => {
      const docs = Array.from({ length: 57 }, (_, i) => makeDoc(i));
      const sort = buildMarketplaceSort(sortBy);
      const expected = [...docs].sort((a, b) => compareBySort(a, b, sort)).map((d) => String(d._id));

      const pages = traverse(docs, { sortBy, pageSize: 10 });

      expect(ids(pages)).toEqual(expected);
      expect(pages.at(-1).hasNextPage).toBe(false);
    }
  );

  it("page size boundary: exact multiple of the page size yields no phantom empty page", () => {
    const docs = Array.from({ length: 20 }, (_, i) => makeDoc(i));
    const pages = traverse(docs, { pageSize: 10 });
    expect(pages).toHaveLength(2);
    expect(pages[1].items).toHaveLength(10);
  });
});

describe("keyset pagination: inserts, deletes and permission changes between requests", () => {
  it("new and older listings inserted mid-traversal never duplicate or shift existing results", () => {
    const docs = Array.from({ length: 30 }, (_, i) => makeDoc(i));
    const original = docs.map((d) => String(d._id));
    const newer = [];
    const older = [];

    const pages = traverse(docs, {
      pageSize: 10,
      between: (index) => {
        if (index !== 0) return;
        for (let n = 0; n < 5; n += 1) {
          const fresh = makeDoc(1000 + n, { createdAt: new Date(BASE + 1_000_000 + n) });
          const stale = makeDoc(2000 + n, { createdAt: new Date(BASE - 1_000_000 - n) });
          newer.push(String(fresh._id));
          older.push(String(stale._id));
          docs.push(fresh, stale);
        }
      },
    });

    const seen = ids(pages);
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    for (const id of original) expect(seen).toContain(id); // nothing skipped
    for (const id of older) expect(seen).toContain(id); // ahead of the cursor: picked up once
    for (const id of newer) expect(seen).not.toContain(id); // behind the cursor: next fresh load shows them
  });

  it("deleting the cursor's own listing and listings ahead of it skips nothing else", () => {
    const docs = Array.from({ length: 40 }, (_, i) => makeDoc(i));
    const originalIds = docs.map((d) => String(d._id));
    const removed = new Set();

    const pages = traverse(docs, {
      pageSize: 10,
      between: (index, page) => {
        if (index !== 0) return;
        const gone = [page.items.at(-1), ...docs.filter((d) => !page.items.includes(d)).slice(0, 3)];
        for (const doc of gone) {
          removed.add(String(doc._id));
          docs.splice(docs.indexOf(doc), 1);
        }
      },
    });

    const seen = ids(pages);
    expect(new Set(seen).size).toBe(seen.length);
    const firstPage = new Set(ids([pages[0]]));
    const expectedLater = originalIds.filter((id) => !firstPage.has(id) && !removed.has(id));
    expect(expectedLater.length).toBe(27);
    expect(seen.slice(firstPage.size)).toEqual(expect.arrayContaining(expectedLater));
    expect(seen.slice(firstPage.size)).toHaveLength(expectedLater.length);
  });

  it.each(HIDERS.map((hide, i) => [i, hide]))(
    "a listing that becomes forbidden between pages (variant %i) never appears afterwards",
    (_, hide) => {
      const docs = Array.from({ length: 40 }, (_, i) => makeDoc(i));
      let forbidden;

      const pages = traverse(docs, {
        pageSize: 10,
        between: (index, page) => {
          if (index !== 0) return;
          // Hide listings strictly ahead of the cursor, plus the cursor listing itself.
          const ahead = visibleNow(docs).filter((d) => !page.items.includes(d));
          forbidden = [page.items.at(-1), ahead[0], ahead[5]];
          forbidden.forEach(hide);
        },
      });

      const later = new Set(ids(pages.slice(1)));
      for (const doc of forbidden) expect(later.has(String(doc._id))).toBe(false);
      // Everything still visible and ahead is delivered exactly once.
      const remaining = ids(pages.slice(1));
      expect(new Set(remaining).size).toBe(remaining.length);
    }
  );

  it("does not advertise a next page when everything remaining was hidden", () => {
    const docs = Array.from({ length: 12 }, (_, i) => makeDoc(i));
    const pages = traverse(docs, {
      pageSize: 10,
      between: (index, page) => {
        if (index === 0) docs.filter((d) => !page.items.includes(d)).forEach((d) => (d.archived = true));
      },
    });
    expect(pages).toHaveLength(2);
    expect(pages[1].items).toEqual([]);
    expect(pages[1].hasNextPage).toBe(false);
  });

  it("the cursor carries only sort keys, never listing content or permission state", () => {
    const sort = buildMarketplaceSort("popular");
    const cursor = encodeMarketplaceCursor(makeDoc(1, { title: "secret draft", moderationStatus: "suspended" }), sort);
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    expect(Object.keys(payload).sort()).toEqual(["_id", "createdAt", "likes", "rating", "s"].sort());
    expect(JSON.stringify(payload)).not.toMatch(/secret|suspended/);
  });

  for (const sortBy of ["newest", "price_asc", "rating_desc"]) {
    it(`randomised churn (${sortBy}): no duplicates, no forbidden results, no skipped survivors`, () => {
      for (let seed = 1; seed <= 25; seed += 1) {
        const random = mulberry32(seed);
        const docs = Array.from({ length: 45 }, (_, i) => makeDoc(i));
        const sort = buildMarketplaceSort(sortBy);
        const startIds = new Set(docs.map((d) => String(d._id)));

        const pages = traverse(docs, {
          sortBy,
          pageSize: 7,
          between: () => {
            const op = random();
            if (op < 0.35) {
              const fresh = makeDoc(Math.floor(random() * 90), { createdAt: new Date(BASE + Math.floor(random() * 40_000) - 10_000) });
              docs.push(fresh);
            } else if (op < 0.65 && docs.length) {
              docs.splice(Math.floor(random() * docs.length), 1);
            } else if (docs.length) {
              HIDERS[Math.floor(random() * HIDERS.length)](docs[Math.floor(random() * docs.length)]);
            }
          },
        });

        const seen = ids(pages);
        const label = `sort=${sortBy} seed=${seed}`;
        expect(new Set(seen).size, `duplicates ${label}`).toBe(seen.length);

        // Every listing still visible at the end that existed from the start and
        // sorts after the first page is delivered (immutable keys => no skips).
        const lastOfFirst = pages[0].items.at(-1);
        const survivors = visibleNow(docs).filter(
          (d) => startIds.has(String(d._id)) && compareBySort(d, lastOfFirst, sort) > 0
        );
        for (const doc of survivors) expect(seen, `skipped ${doc._id} ${label}`).toContain(String(doc._id));
      }
    });
  }
});

describe("cursor validation and null handling", () => {
  const sort = buildMarketplaceSort("price_asc");
  const encodeRaw = (data) => Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
  const valid = { _id: "507f1f77bcf86cd799439011", price: 10, createdAt: "2026-01-01T00:00:00.000Z" };

  it("rejects garbage, missing ids and missing sort fields", () => {
    expect(() => decodeMarketplaceCursor("%%%", sort)).toThrow(/Invalid marketplace cursor/);
    expect(() => decodeMarketplaceCursor(encodeRaw({ price: 1, createdAt: "x" }), sort)).toThrow();
    expect(() => decodeMarketplaceCursor(encodeRaw({ _id: valid._id, price: 1 }), sort)).toThrow();
  });

  it("rejects operator injection and invalid dates", () => {
    expect(() => decodeMarketplaceCursor(encodeRaw({ ...valid, price: { $ne: 1 } }), sort)).toThrow();
    expect(() => decodeMarketplaceCursor(encodeRaw({ ...valid, createdAt: ["a"] }), sort)).toThrow();
    expect(() => decodeMarketplaceCursor(encodeRaw({ ...valid, createdAt: "not-a-date" }), sort)).toThrow();
  });

  it("rejects a cursor issued for a different sort order, but accepts pre-signature cursors", () => {
    const cursor = encodeMarketplaceCursor(makeDoc(1), buildMarketplaceSort("newest"));
    expect(() => decodeMarketplaceCursor(cursor, sort)).toThrow(/Invalid marketplace cursor/);
    expect(decodeMarketplaceCursor(encodeRaw(valid), sort)._id).toBe(valid._id);
  });

  it("encodes a missing sort value as null instead of dropping it", () => {
    const ratingSort = buildMarketplaceSort("rating_desc");
    const cursor = encodeMarketplaceCursor(makeDoc(0, { rating: undefined }), ratingSort);
    expect(decodeMarketplaceCursor(cursor, ratingSort).rating).toBeNull();
  });

  it("descending cursor on a valued field also admits listings missing that field", () => {
    const desc = buildMarketplaceSort("rating_desc");
    const clause = buildMarketplaceCursorClause({ ...valid, rating: 3 }, desc);
    expect(clause.$or[0].$or).toEqual([{ rating: { $lt: 3 } }, { rating: null }]);
  });

  it("null cursor value: ascending continues with all non-null values; descending adds no range clause", () => {
    const asc = buildMarketplaceCursorClause({ ...valid, price: null }, sort).$or[0];
    expect(asc.price).toEqual({ $ne: null });

    const desc = buildMarketplaceSort("price_desc");
    const clause = buildMarketplaceCursorClause({ ...valid, price: null }, desc);
    expect(clause.$or.some((c) => c.price && c.price.$lt !== undefined)).toBe(false);
    expect(clause.$or).toHaveLength(2); // createdAt and _id tie-breakers remain
  });
});
