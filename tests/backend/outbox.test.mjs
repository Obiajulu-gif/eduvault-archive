import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OUTBOX_STATUSES,
  DEFAULT_OUTBOX_CONFIG,
  computeNextAttempt,
  enqueueOutboxIntent,
  leaseNextIntent,
  completeOutboxIntent,
  failOutboxIntent,
  reclaimExpiredLeases,
  retryFailedOutboxIntent,
  getOutboxHealth,
} from "../../src/lib/backend/outbox.js";

function matchesCondition(value, condition) {
  for (const [operator, expected] of Object.entries(condition)) {
    if (operator === "$lte") {
      if (value === undefined || value === null) return false;
      if (new Date(value).getTime() > new Date(expected).getTime()) return false;
    } else {
      return false;
    }
  }
  return true;
}

function matchesFilter(doc, filter) {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === "$or") {
      const matched = expected.some((subFilter) => matchesFilter(doc, subFilter));
      if (!matched) return false;
      continue;
    }

    const value = doc[key];

    if (expected !== null && typeof expected === "object" && !Array.isArray(expected) && !(expected instanceof Date)) {
      if (!matchesCondition(value, expected)) return false;
      continue;
    }

    const normalizedValue = value instanceof Date ? value.getTime() : value;
    const normalizedExpected = expected instanceof Date ? expected.getTime() : expected;

    if (key.includes(".")) {
      const [parent, child] = key.split(".");
      if (doc[parent]?.[child] !== normalizedExpected) return false;
      continue;
    }

    if (normalizedValue !== normalizedExpected) return false;
  }
  return true;
}

function applyUpdate(doc, update) {
  return { ...doc, ...(update.$set || {}) };
}

function sortDocs(docs, sort) {
  if (!sort) return docs;
  const entries = Object.entries(sort);
  return [...docs].sort((a, b) => {
    for (const [field, direction] of entries) {
      const av = a[field] instanceof Date ? a[field].getTime() : a[field] ?? Infinity;
      const bv = b[field] instanceof Date ? b[field].getTime() : b[field] ?? Infinity;
      if (av < bv) return -1 * direction;
      if (av > bv) return 1 * direction;
    }
    return 0;
  });
}

function createCollection() {
  const records = new Map();
  let nextId = 1;

  return {
    records,
    async insertOne(doc) {
      const _id = doc._id ?? `intent-${nextId++}`;
      records.set(_id, { ...doc, _id });
      return { insertedId: _id };
    },
    async findOne(filter = {}) {
      for (const doc of records.values()) {
        if (matchesFilter(doc, filter)) return { ...doc };
      }
      return null;
    },
    find(filter = {}) {
      let sorted = null;
      const results = [];
      for (const doc of records.values()) {
        if (matchesFilter(doc, filter)) results.push({ ...doc });
      }
      return {
        sort(sortSpec) {
          sorted = sortSpec;
          return this;
        },
        toArray: async () => (sorted ? sortDocs(results, sorted) : results),
      };
    },
    async findOneAndUpdate(filter, update, options = {}) {
      let candidates = [];
      for (const doc of records.values()) {
        if (matchesFilter(doc, filter)) candidates.push(doc);
      }
      candidates = sortDocs(candidates, options.sort);
      const target = candidates[0];
      if (!target) return null;
      const updated = applyUpdate(target, update);
      records.set(target._id, updated);
      return { ...updated };
    },
    async updateMany(filter, update) {
      let modifiedCount = 0;
      for (const [_id, doc] of records.entries()) {
        if (matchesFilter(doc, filter)) {
          records.set(_id, applyUpdate(doc, update));
          modifiedCount += 1;
        }
      }
      return { modifiedCount };
    },
  };
}

function createDb() {
  const collections = new Map();
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, createCollection());
      return collections.get(name);
    },
  };
}

test("computeNextAttempt doubles exponentially and caps at maxDelayMs", () => {
  const base = new Date("2026-01-01T00:00:00Z");
  const config = { baseDelayMs: 1000, maxDelayMs: 8000 };

  assert.equal(computeNextAttempt(1, config, base).getTime(), base.getTime() + 1000);
  assert.equal(computeNextAttempt(2, config, base).getTime(), base.getTime() + 2000);
  assert.equal(computeNextAttempt(3, config, base).getTime(), base.getTime() + 4000);
  assert.equal(computeNextAttempt(10, config, base).getTime(), base.getTime() + 8000);
});

test("leased entries are not handed out twice", async () => {
  const db = createDb();
  const t0 = new Date("2026-01-01T00:00:00Z");

  await enqueueOutboxIntent(db, { type: "email", payload: { to: "buyer@example.com" } }, { now: t0 });

  const lease = await leaseNextIntent(db, { now: t0 });
  assert.ok(lease);
  assert.equal(lease.status, OUTBOX_STATUSES.LEASED);

  const secondLease = await leaseNextIntent(db, { now: t0 });
  assert.equal(secondLease, null);
});

test("failing below maxAttempts reschedules with backoff and keeps entry out of leasing until due", async () => {
  const db = createDb();
  const t0 = new Date("2026-01-01T00:00:00Z");

  await enqueueOutboxIntent(db, { type: "webhook", payload: { url: "https://example.test" } }, { now: t0 });
  const leased = await leaseNextIntent(db, { now: t0 });

  const failed = await failOutboxIntent(db, leased._id, "smtp down", {
    now: t0,
    config: { baseDelayMs: 1000, maxDelayMs: 8000 },
  });

  assert.equal(failed.status, OUTBOX_STATUSES.PENDING);
  assert.equal(failed.attemptCount, 1);
  assert.equal(failed.lastError, "smtp down");
  assert.deepEqual(failed.nextAttemptAt, new Date(t0.getTime() + 1000));

  const earlyLease = await leaseNextIntent(db, { now: t0 });
  assert.equal(earlyLease, null);

  const dueLease = await leaseNextIntent(db, { now: new Date(t0.getTime() + 1000) });
  assert.ok(dueLease);
  assert.equal(dueLease.attemptCount, 1);
});

test("entry reaching maxAttempts transitions to terminal failed and is never leased again", async () => {
  const db = createDb();
  let now = new Date("2026-01-01T00:00:00Z");

  await enqueueOutboxIntent(db, { type: "email", payload: { to: "buyer@example.com" } }, { now });
  const config = { baseDelayMs: 0, maxDelayMs: 0 };
  let lastError = null;

  for (let i = 1; i <= DEFAULT_OUTBOX_CONFIG.maxAttempts; i += 1) {
    const leased = await leaseNextIntent(db, { now });
    assert.ok(leased, `attempt ${i} should be leasable`);

    lastError = await failOutboxIntent(db, leased._id, `failure ${i}`, { now, config });

    if (i < DEFAULT_OUTBOX_CONFIG.maxAttempts) {
      assert.equal(lastError.status, OUTBOX_STATUSES.PENDING);
    }
    now = new Date(now.getTime() + 60_000);
  }

  assert.equal(lastError.status, OUTBOX_STATUSES.FAILED);
  assert.equal(lastError.attemptCount, DEFAULT_OUTBOX_CONFIG.maxAttempts);
  assert.equal(lastError.lastError, `failure ${DEFAULT_OUTBOX_CONFIG.maxAttempts}`);
  assert.ok(lastError.failedAt instanceof Date);

  const shouldNotLease = await leaseNextIntent(db, { now: new Date(now.getTime() + 3_600_000) });
  assert.equal(shouldNotLease, null);

  const alreadyFailed = await failOutboxIntent(
    db,
    lastError._id,
    "extra failure",
    { now, config }
  );
  assert.equal(alreadyFailed, null);
});

test("expired leases are reclaimed back to pending", async () => {
  const db = createDb();
  const t0 = new Date("2026-01-01T00:00:00Z");

  await enqueueOutboxIntent(db, { type: "email", payload: {} }, { now: t0 });
  await leaseNextIntent(db, { now: t0 });

  const reclaimed = await reclaimExpiredLeases(db, {
    now: new Date(t0.getTime() + DEFAULT_OUTBOX_CONFIG.leaseDurationMs),
  });

  assert.equal(reclaimed, 1);
  const record = [...db.collection("outbox").records.values()][0];
  assert.equal(record.status, OUTBOX_STATUSES.PENDING);
});

test("manual retry re-enables leasing for a failed entry", async () => {
  const db = createDb();
  let now = new Date("2026-01-01T00:00:00Z");
  const config = { baseDelayMs: 0, maxDelayMs: 0 };

  const enqueued = await enqueueOutboxIntent(db, { type: "email", payload: {} }, { now });

  for (let i = 0; i < DEFAULT_OUTBOX_CONFIG.maxAttempts; i += 1) {
    const leased = await leaseNextIntent(db, { now });
    await failOutboxIntent(db, leased._id, "still broken", { now, config });
    now = new Date(now.getTime() + 60_000);
  }

  const beforeRetry = await leaseNextIntent(db, { now });
  assert.equal(beforeRetry, null);

  const retried = await retryFailedOutboxIntent(db, enqueued._id, { now });
  assert.ok(retried);
  assert.equal(retried.status, OUTBOX_STATUSES.PENDING);
  assert.equal(retried.attemptCount, 0);
  assert.equal(retried.lastError, null);
  assert.equal(retried.nextAttemptAt.getTime(), now.getTime());

  const reLeased = await leaseNextIntent(db, { now });
  assert.ok(reLeased);
  assert.equal(reLeased._id, enqueued._id);
});

test("retry only applies to failed entries", async () => {
  const db = createDb();
  const t0 = new Date("2026-01-01T00:00:00Z");

  const pending = await enqueueOutboxIntent(db, { type: "email", payload: {} }, { now: t0 });
  const result = await retryFailedOutboxIntent(db, pending._id, { now: t0 });
  assert.equal(result, null);
});

test("getOutboxHealth reports counts and oldest unresolved age", async () => {
  const db = createDb();
  const t0 = new Date("2026-01-01T00:00:00Z");
  const later = new Date(t0.getTime() + 120_000);
  const query = new Date(later.getTime() + 300_000);
  const config = { baseDelayMs: 0, maxDelayMs: 0 };

  const completedIntent = await enqueueOutboxIntent(db, { type: "email", payload: {} }, { now: t0 });
  const failedIntent = await enqueueOutboxIntent(db, { type: "email", payload: {} }, { now: later });

  let leased = await leaseNextIntent(db, { now: query });
  assert.equal(leased._id, completedIntent._id);
  await completeOutboxIntent(db, leased._id, { now: query });

  for (let i = 0; i < DEFAULT_OUTBOX_CONFIG.maxAttempts; i += 1) {
    leased = await leaseNextIntent(db, { now: query });
    assert.equal(leased._id, failedIntent._id);
    await failOutboxIntent(db, leased._id, "boom", { now: query, config });
  }

  const health = await getOutboxHealth(db, { now: query });

  assert.equal(health.total, 2);
  assert.equal(health.completed, 1);
  assert.equal(health.failed, 1);
  assert.equal(health.pending, 0);
  assert.equal(health.needsAttention, true);
  assert.deepEqual(health.oldestUnresolvedAt, later);
  assert.equal(
    health.oldestUnresolvedAgeSeconds,
    Math.floor((query.getTime() - later.getTime()) / 1000)
  );

  const healthyEmpty = await getOutboxHealth(createDb(), { now: query });
  assert.equal(healthyEmpty.total, 0);
  assert.equal(healthyEmpty.needsAttention, false);
  assert.equal(healthyEmpty.oldestUnresolvedAgeSeconds, null);
});
