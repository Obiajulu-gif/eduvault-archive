import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBoundedCache, PUBLIC_SCOPE } from "../../src/lib/cache/boundedCache.js";
import {
  CACHE_DRIFT_CATEGORY,
  CACHE_REPAIR_ACTION,
  reconcileSourceAndCache,
  rollbackCacheRepairs,
} from "../../src/lib/reconciliation/sourceCacheReconciler.js";

const noSleep = async () => {};

describe("source-to-cache reconciliation (#1073)", () => {
  it("normal path: dry-run detects drift without mutating cache, then execute repairs idempotently", async () => {
    let clock = 1_000_000;
    const cache = createBoundedCache({ now: () => clock, defaultTtlMs: 10_000 });

    // 1. Stale version in cache
    cache.set("mat-1", { title: "Old Title" }, { scope: PUBLIC_SCOPE, version: 1 });
    // 2. Value divergence (same version, different payload)
    cache.set("mat-2", { title: "Cached Copy" }, { scope: PUBLIC_SCOPE, version: 3 });
    // 3. Orphan in cache (not in source)
    cache.set("mat-orphan", { title: "Deleted" }, { scope: PUBLIC_SCOPE, version: 1 });
    // 4. Expired entry in cache
    cache.set("mat-expired", { title: "Expired" }, { scope: PUBLIC_SCOPE, version: 1, ttlMs: 500 });
    // 5. Scope leak: private record cached in PUBLIC_SCOPE
    cache.set("mat-private", { title: "Secret Draft" }, { scope: PUBLIC_SCOPE, version: 1 });

    clock += 1_000; // mat-expired is now expired

    const sourceRecords = [
      { key: "mat-1", scope: PUBLIC_SCOPE, value: { title: "New Title" }, version: 2 },
      { key: "mat-2", scope: PUBLIC_SCOPE, value: { title: "Source Copy" }, version: 3 },
      { key: "mat-expired", scope: PUBLIC_SCOPE, value: { title: "Fresh" }, version: 1 },
      { key: "mat-missing", scope: PUBLIC_SCOPE, value: { title: "Missing" }, version: 1 },
      { key: "mat-private", scope: "user:creator-1", value: { title: "Secret Draft" }, version: 1 },
    ];

    // Dry-run first
    const dryReport = await reconcileSourceAndCache({
      loadSourceRecords: async () => sourceRecords,
      cache,
      actor: { role: "operator", id: "op-1" },
      dryRun: true,
      now: () => clock,
    });

    assert.equal(dryReport.dryRun, true);
    assert.equal(dryReport.driftCount, 7);
    assert.equal(dryReport.repairedCount, 0);
    assert.equal(dryReport.byCategory[CACHE_DRIFT_CATEGORY.STALE_VERSION], 1);
    assert.equal(dryReport.byCategory[CACHE_DRIFT_CATEGORY.VALUE_DIVERGENCE], 1);
    assert.equal(dryReport.byCategory[CACHE_DRIFT_CATEGORY.ORPHAN_IN_CACHE], 1);
    assert.equal(dryReport.byCategory[CACHE_DRIFT_CATEGORY.EXPIRED_IN_CACHE], 1);
    assert.equal(dryReport.byCategory[CACHE_DRIFT_CATEGORY.MISSING_IN_CACHE], 2); // mat-missing + mat-private in user:creator-1
    // Scope leak is detected on mat-private in PUBLIC_SCOPE
    const leak = dryReport.driftItems.find((d) => d.category === CACHE_DRIFT_CATEGORY.SCOPE_LEAK);
    assert.ok(leak);
    assert.equal(leak.plannedAction, CACHE_REPAIR_ACTION.INVALIDATE_CACHE);
    // Dry-run must not mutate cache
    assert.deepEqual(cache.get("mat-1", { scope: PUBLIC_SCOPE }), { title: "Old Title" });
    assert.equal(cache.get("mat-missing", { scope: PUBLIC_SCOPE }), undefined);

    // Execute repair
    const auditEvents = [];
    const execReport = await reconcileSourceAndCache({
      loadSourceRecords: async () => sourceRecords,
      cache,
      actor: { role: "operator", id: "op-1" },
      dryRun: false,
      now: () => clock,
      auditSink: (ev) => auditEvents.push(ev),
    });

    assert.equal(execReport.dryRun, false);
    assert.equal(execReport.driftCount, 7); // 6 + 1 scope_leak
    assert.equal(execReport.repairedCount, 7);
    assert.equal(execReport.errorsCount, 0);
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].action, "reconciliation.source_cache_repaired");

    // Verify repaired cache state
    assert.deepEqual(cache.get("mat-1", { scope: PUBLIC_SCOPE }), { title: "New Title" });
    assert.deepEqual(cache.get("mat-2", { scope: PUBLIC_SCOPE }), { title: "Source Copy" });
    assert.equal(cache.get("mat-orphan", { scope: PUBLIC_SCOPE }), undefined);
    assert.equal(cache.get("mat-private", { scope: PUBLIC_SCOPE }), undefined);
    assert.deepEqual(cache.get("mat-private", { scope: "user:creator-1" }), { title: "Secret Draft" });

    // Idempotent second run -> zero drift
    const postReport = await reconcileSourceAndCache({
      loadSourceRecords: async () => sourceRecords,
      cache,
      actor: "system",
      dryRun: true,
      now: () => clock,
    });
    assert.equal(postReport.driftCount, 0);
  });

  it("authorization path: rejects missing or non-privileged actors before touching source or cache", async () => {
    const cache = createBoundedCache();
    let sourceCalled = false;
    const loadSourceRecords = () => {
      sourceCalled = true;
      return [];
    };

    for (const actor of [null, undefined, "learner", { role: "creator" }, { role: "anonymous" }]) {
      await assert.rejects(
        () => reconcileSourceAndCache({ loadSourceRecords, cache, actor }),
        (err) => err.status === 403
      );
    }

    await assert.rejects(
      () =>
        reconcileSourceAndCache({
          loadSourceRecords,
          cache,
          actor: { role: "admin" },
          authorize: () => false,
        }),
      (err) => err.status === 403
    );

    assert.equal(sourceCalled, false);
  });

  it("retry path: recovers from transient source load and cache write failures", async () => {
    const baseCache = createBoundedCache();
    let loadAttempts = 0;
    let setAttempts = 0;

    const flakyCache = {
      snapshot: (opts) => baseCache.snapshot(opts),
      invalidate: (key, opts) => baseCache.invalidate(key, opts),
      set(key, value, opts) {
        setAttempts += 1;
        if (setAttempts === 1) throw new Error("transient cache write error");
        return baseCache.set(key, value, opts);
      },
    };

    const report = await reconcileSourceAndCache({
      loadSourceRecords: async () => {
        loadAttempts += 1;
        if (loadAttempts < 2) throw new Error("transient source timeout");
        return [{ key: "mat-retry", scope: PUBLIC_SCOPE, value: { ok: true }, version: 1 }];
      },
      cache: flakyCache,
      actor: "system",
      dryRun: false,
      maxRetries: 2,
      retryDelayMs: 0,
      sleep: noSleep,
    });

    assert.equal(loadAttempts, 2);
    assert.equal(setAttempts, 2);
    assert.equal(report.repairedCount, 1);
    assert.equal(report.errorsCount, 0);
    assert.equal(report.retriedCount, 2); // 1 source retry + 1 cache write retry
    assert.deepEqual(baseCache.get("mat-retry", { scope: PUBLIC_SCOPE }), { ok: true });
  });

  it("failure path: records permanent per-item errors without aborting healthy repairs", async () => {
    const cache = createBoundedCache({ maxBytes: 128 });
    const hugeValue = { data: "x".repeat(500) };

    const report = await reconcileSourceAndCache({
      loadSourceRecords: () => [
        { key: "too-big", scope: PUBLIC_SCOPE, value: hugeValue, version: 1 },
        { key: "fits-fine", scope: PUBLIC_SCOPE, value: { ok: 1 }, version: 1 },
      ],
      cache,
      actor: "admin",
      dryRun: false,
      maxRetries: 1,
      retryDelayMs: 0,
      sleep: noSleep,
    });

    assert.equal(report.repairedCount, 1);
    assert.equal(report.errorsCount, 1);
    assert.equal(report.failedItems.length, 1);
    assert.equal(report.failedItems[0].key, "too-big");
    assert.deepEqual(cache.get("fits-fine", { scope: PUBLIC_SCOPE }), { ok: 1 });
  });

  it("rollback path: rollbackCacheRepairs restores pre-repair cache state", async () => {
    const cache = createBoundedCache();
    cache.set("mat-1", { title: "Before" }, { scope: PUBLIC_SCOPE, version: 1 });

    const report = await reconcileSourceAndCache({
      loadSourceRecords: () => [
        { key: "mat-1", scope: PUBLIC_SCOPE, value: { title: "After" }, version: 2 },
        { key: "mat-new", scope: PUBLIC_SCOPE, value: { title: "Inserted" }, version: 1 },
      ],
      cache,
      actor: "operator",
      dryRun: false,
    });

    assert.deepEqual(cache.get("mat-1", { scope: PUBLIC_SCOPE }), { title: "After" });
    assert.deepEqual(cache.get("mat-new", { scope: PUBLIC_SCOPE }), { title: "Inserted" });

    const rollback = rollbackCacheRepairs(cache, report.rollbackSnapshot);
    assert.equal(rollback.restoredCount, 1);
    assert.equal(rollback.invalidatedCount, 1);
    assert.deepEqual(cache.get("mat-1", { scope: PUBLIC_SCOPE }), { title: "Before" });
    assert.equal(cache.get("mat-new", { scope: PUBLIC_SCOPE }), undefined);
  });
});
