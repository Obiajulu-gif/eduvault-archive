import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COLLECTIONS,
  REQUIRED_INDEXES,
  TTL_INDEXES,
} from "../../src/lib/backend/schemaContracts.js";
import { ADMIN_AUDIT_COLLECTION } from "../../src/lib/db/schemas/auditLog.js";

/**
 * Index verification.
 *
 * A missing index never fails a query — it silently degrades into a collection
 * scan that only shows up as latency under production data volume. A missing
 * TTL index is worse: the collection just grows forever with nothing to signal
 * it. These checks assert the declared index set is intact, and that every
 * declaration is actually well-formed enough for MongoDB to accept.
 *
 * `REQUIRED_INDEXES` is the single registry that `ensureIndexes()` drives from,
 * so asserting against it is equivalent to asserting what gets created at
 * startup — without needing a live database, which keeps this in the
 * `npm run test:backend` suite rather than behind an integration harness.
 *
 * Where a real database is available (`MONGODB_URI` set), the last block
 * connects and verifies the indexes are genuinely present on the server.
 */

/** Collections whose indexes are load-bearing for user-facing queries. */
const CRITICAL_COLLECTIONS = ["materials", "users", "purchases"];

function indexNameFor({ keys, options }) {
  if (options?.name) return options.name;
  return Object.entries(keys)
    .map(([field, direction]) => `${field}_${direction}`)
    .join("_");
}

// ── Registry shape ───────────────────────────────────────────────────────────

test("every required index declares a non-empty key specification", () => {
  for (const [collection, indexes] of Object.entries(REQUIRED_INDEXES)) {
    assert.ok(Array.isArray(indexes), `${collection} must declare an array of indexes`);
    assert.ok(indexes.length > 0, `${collection} declares no indexes`);

    for (const index of indexes) {
      assert.ok(index.keys, `${collection} has an index with no keys`);
      assert.ok(
        Object.keys(index.keys).length > 0,
        `${collection} has an index with an empty key spec`
      );

      for (const [field, direction] of Object.entries(index.keys)) {
        assert.ok(
          direction === 1 || direction === -1 || direction === "text",
          `${collection}.${field} has invalid direction ${JSON.stringify(direction)}`
        );
      }
    }
  }
});

test("no collection declares the same index twice", () => {
  // Duplicate declarations are silently accepted by createIndex but make the
  // registry lie about what exists, and mask a typo in one of the pair.
  for (const [collection, indexes] of Object.entries(REQUIRED_INDEXES)) {
    const names = indexes.map(indexNameFor);
    assert.equal(
      new Set(names).size,
      names.length,
      `${collection} declares duplicate indexes: ${names.join(", ")}`
    );
  }
});

test("at most one text index per collection", () => {
  // MongoDB permits exactly one text index per collection; a second declaration
  // fails at startup, and ensureIndexes only logs that failure.
  for (const [collection, indexes] of Object.entries(REQUIRED_INDEXES)) {
    const textIndexes = indexes.filter((index) =>
      Object.values(index.keys).includes("text")
    );
    assert.ok(
      textIndexes.length <= 1,
      `${collection} declares ${textIndexes.length} text indexes; MongoDB allows one`
    );
  }
});

// ── Critical collections ─────────────────────────────────────────────────────

for (const collection of CRITICAL_COLLECTIONS) {
  test(`${collection} declares required indexes`, () => {
    const indexes = REQUIRED_INDEXES[collection];
    assert.ok(indexes, `${collection} has no index declarations at all`);
    assert.ok(indexes.length > 0, `${collection} declares no indexes`);
  });
}

test("materials indexes cover the public catalog query", () => {
  // buildMarketplaceDiscoveryQuery filters on visibility, isDeleted and
  // creatorSuspended on every catalog request. Without indexes on those, the
  // marketplace page degrades to a collection scan as retired listings build up.
  const indexed = new Set(
    REQUIRED_INDEXES.materials.flatMap((index) => Object.keys(index.keys))
  );

  for (const field of ["visibility", "isDeleted", "creatorSuspended", "category", "createdAt"]) {
    assert.ok(indexed.has(field), `materials is missing an index covering ${field}`);
  }
});

test("materials declares a text index for search", () => {
  const hasTextIndex = REQUIRED_INDEXES.materials.some((index) =>
    Object.values(index.keys).includes("text")
  );
  assert.ok(hasTextIndex, "materials has no text index; search falls back to a scan");
});

test("users enforces a unique email index", () => {
  const emailIndex = REQUIRED_INDEXES.users.find((index) => "email" in index.keys);
  assert.ok(emailIndex, "users has no email index");
  assert.equal(emailIndex.options?.unique, true, "users.email index must be unique");
});

test("purchases prevents duplicate entitlements for the same buyer", () => {
  const pairIndex = REQUIRED_INDEXES.purchases.find(
    (index) => "materialId" in index.keys && "buyerAddress" in index.keys
  );
  assert.ok(pairIndex, "purchases has no (materialId, buyerAddress) index");
  assert.equal(
    pairIndex.options?.unique,
    true,
    "the (materialId, buyerAddress) index must be unique or a buyer can be double-charged"
  );
});

test("purchases enforces a unique chain transaction hash", () => {
  const txIndex = REQUIRED_INDEXES.purchases.find((index) => "chainTxHash" in index.keys);
  assert.ok(txIndex, "purchases has no chainTxHash index");
  assert.equal(txIndex.options?.unique, true, "chainTxHash must be unique to stop replay");
});

// ── Administrative audit log ─────────────────────────────────────────────────

test("admin audit log declares indexes for both lookup directions", () => {
  const indexes = REQUIRED_INDEXES[ADMIN_AUDIT_COLLECTION];
  assert.ok(indexes, "admin audit log has no index declarations");

  const indexed = indexes.map((index) => Object.keys(index.keys).join(","));
  assert.ok(
    indexed.some((keys) => keys.startsWith("admin_id")),
    "cannot query the audit log by actor"
  );
  assert.ok(
    indexed.some((keys) => keys.startsWith("target_user")),
    "cannot query the audit log by target"
  );
});

test("admin audit collection is registered in COLLECTIONS", () => {
  assert.equal(COLLECTIONS.adminAuditLog, ADMIN_AUDIT_COLLECTION);
});

// ── TTL indexes ──────────────────────────────────────────────────────────────

test("TTL indexes are declared for every temporary collection", () => {
  assert.ok(
    Object.keys(TTL_INDEXES).length > 0,
    "no TTL indexes declared; temporary collections would grow without bound"
  );

  for (const [collection, index] of Object.entries(TTL_INDEXES)) {
    assert.ok(index.keys, `${collection} TTL index has no key spec`);
    assert.equal(
      Object.keys(index.keys).length,
      1,
      `${collection} TTL index must be on exactly one field; MongoDB rejects compound TTL indexes`
    );
    assert.equal(
      typeof index.options?.expireAfterSeconds,
      "number",
      `${collection} declares a TTL index without expireAfterSeconds — it will never expire anything`
    );
    assert.ok(
      index.options.expireAfterSeconds >= 0,
      `${collection} has a negative expireAfterSeconds`
    );
  }
});

test("quarantine collection expires records on its own", () => {
  const quarantine = TTL_INDEXES.content_quarantine;
  assert.ok(quarantine, "content_quarantine has no TTL index");
  assert.ok(
    "expiresAt" in quarantine.keys,
    "the quarantine TTL index must be on expiresAt to match the documents written"
  );
  assert.equal(
    quarantine.options.expireAfterSeconds,
    0,
    "expireAfterSeconds must be 0 so the per-document expiresAt value is honoured"
  );
});

// ── Live database verification (skipped without MONGODB_URI) ─────────────────

test("declared indexes exist on the live database", { skip: !process.env.MONGODB_URI }, async () => {
  const { getDb } = await import("../../src/lib/mongodb.js");
  const db = await getDb();

  const missing = [];

  for (const collection of CRITICAL_COLLECTIONS) {
    const existing = await db.collection(collection).indexes();
    const existingKeys = existing.map((index) => JSON.stringify(index.key));

    for (const declared of REQUIRED_INDEXES[collection]) {
      if (!existingKeys.includes(JSON.stringify(declared.keys))) {
        missing.push(`${collection}: ${JSON.stringify(declared.keys)}`);
      }
    }
  }

  assert.deepEqual(missing, [], `indexes missing from the live database:\n${missing.join("\n")}`);
});

test("TTL indexes exist on the live database", { skip: !process.env.MONGODB_URI }, async () => {
  const { getDb } = await import("../../src/lib/mongodb.js");
  const db = await getDb();

  for (const [collection, declared] of Object.entries(TTL_INDEXES)) {
    const existing = await db.collection(collection).indexes();
    const ttlIndex = existing.find(
      (index) => JSON.stringify(index.key) === JSON.stringify(declared.keys)
    );

    assert.ok(ttlIndex, `${collection} is missing its TTL index`);
    assert.equal(
      ttlIndex.expireAfterSeconds,
      declared.options.expireAfterSeconds,
      `${collection} TTL index has the wrong expireAfterSeconds`
    );
  }
});
