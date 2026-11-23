import { beforeEach, describe, expect, it, vi } from "vitest";
import { LookupStatus, PUBLIC_SCOPE, createBoundedCache } from "./boundedCache.js";

let clock;
let sleeps;

function makeCache(options = {}) {
  return createBoundedCache({
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); },
    ...options,
  });
}

const pub = (extra = {}) => ({ scope: PUBLIC_SCOPE, ...extra });

beforeEach(() => {
  clock = 1_000_000;
  sleeps = [];
});

describe("basic reads and bounds", () => {
  it("returns what was stored and reports a miss otherwise", () => {
    const cache = makeCache();
    expect(cache.lookup("a", pub()).status).toBe(LookupStatus.MISS);
    cache.set("a", { n: 1 }, pub());
    expect(cache.get("a", pub())).toEqual({ n: 1 });
  });

  it("hands out copies so callers cannot corrupt the cached value", () => {
    const cache = makeCache();
    const original = { list: [1] };
    cache.set("a", original, pub());
    original.list.push(2);
    cache.get("a", pub()).list.push(3);
    expect(cache.get("a", pub())).toEqual({ list: [1] });
  });

  it("evicts the least recently used entry at maxEntries", () => {
    const cache = makeCache({ maxEntries: 2 });
    cache.set("a", 1, pub());
    cache.set("b", 2, pub());
    cache.get("a", pub()); // a is now most recent
    cache.set("c", 3, pub());
    expect(cache.get("b", pub())).toBeUndefined();
    expect(cache.get("a", pub())).toBe(1);
    expect(cache.get("c", pub())).toBe(3);
    expect(cache.stats()).toMatchObject({ size: 2, evictions: 1 });
  });

  it("stays under maxBytes and refuses a single entry that can never fit", () => {
    const cache = makeCache({ maxBytes: 100, sizeOf: (v) => v.length });
    cache.set("a", "x".repeat(60), pub());
    cache.set("b", "y".repeat(60), pub());
    expect(cache.get("a", pub())).toBeUndefined();
    expect(cache.stats().bytes).toBe(60);
    expect(cache.set("huge", "z".repeat(101), pub())).toBe(false);
    expect(cache.get("b", pub())).toBe("y".repeat(60));
    expect(cache.stats().rejected).toBe(1);
  });

  it("does not leave an old copy behind when the replacement is too large", () => {
    const cache = makeCache({ maxBytes: 10, sizeOf: (v) => v.length });
    cache.set("a", "old", pub());
    cache.set("a", "x".repeat(11), pub());
    expect(cache.get("a", pub())).toBeUndefined();
  });

  it("refuses values it cannot copy instead of throwing", () => {
    const cache = makeCache();
    expect(cache.set("fn", { f() {} }, pub())).toBe(false);
  });

  it("validates its inputs", () => {
    const cache = makeCache();
    expect(() => cache.set("", 1, pub())).toThrow();
    expect(() => cache.set("a", 1, {})).toThrow(/scope/);
    expect(() => cache.set("a", 1, pub({ ttlMs: 0 }))).toThrow(/ttlMs/);
    expect(() => createBoundedCache({ maxEntries: 0 })).toThrow(/maxEntries/);
  });
});

describe("expiry and stale detection", () => {
  it("expires entries after their ttl", () => {
    const cache = makeCache({ defaultTtlMs: 1000 });
    cache.set("a", 1, pub());
    clock += 999;
    expect(cache.get("a", pub())).toBe(1);
    clock += 1;
    expect(cache.lookup("a", pub()).status).toBe(LookupStatus.EXPIRED);
    expect(cache.stats().size).toBe(0);
  });

  it("reports and drops an entry whose source version moved on", () => {
    const cache = makeCache();
    cache.set("a", "v1-data", pub({ version: 1 }));
    expect(cache.lookup("a", pub({ version: 1 })).status).toBe(LookupStatus.HIT);
    const result = cache.lookup("a", pub({ version: 2 }));
    expect(result).toMatchObject({ status: LookupStatus.STALE, cachedVersion: 1, currentVersion: 2 });
    expect(cache.lookup("a", pub({ version: 2 })).status).toBe(LookupStatus.MISS);
  });

  it("findStale lists expired and version-behind entries without mutating", () => {
    const cache = makeCache({ defaultTtlMs: 1000 });
    cache.set("old", 1, pub({ version: 1, ttlMs: 100 }));
    cache.set("behind", 1, pub({ version: 1 }));
    cache.set("current", 1, pub({ version: 2 }));
    clock += 500;
    const findings = cache.findStale({ versionFor: () => 2 });
    expect(findings.map((f) => [f.key, f.reason]).sort()).toEqual([["behind", "version_behind"], ["old", "expired"]]);
    expect(cache.stats().size).toBe(3);
    const purged = cache.purgeStale({ versionFor: () => 2 });
    expect(purged.removed).toBe(2);
    expect(cache.stats().size).toBe(1);
  });
});

describe("explicit invalidation", () => {
  it("invalidates a single key, a tag, a prefix and everything", () => {
    const cache = makeCache();
    cache.set("material:1:page", "a", pub({ tags: ["material:1"] }));
    cache.set("material:1:detail", "b", pub({ tags: ["material:1"] }));
    cache.set("material:2:detail", "c", pub({ tags: ["material:2"] }));
    cache.set("other", "d", pub());

    expect(cache.invalidate("other", pub())).toBe(1);
    expect(cache.invalidate("other", pub())).toBe(0);
    expect(cache.invalidateTag("material:1")).toBe(2);
    expect(cache.get("material:2:detail", pub())).toBe("c");
    expect(cache.invalidatePrefix("material:2")).toBe(1);
    cache.set("x", 1, pub());
    expect(cache.clear()).toBe(1);
    expect(cache.stats()).toMatchObject({ size: 0, bytes: 0 });
  });

  it("cleans the tag index when entries are evicted or replaced", () => {
    const cache = makeCache({ maxEntries: 1 });
    cache.set("a", 1, pub({ tags: ["t"] }));
    cache.set("b", 2, pub());
    expect(cache.invalidateTag("t")).toBe(0);
    cache.set("c", 1, pub({ tags: ["t"] }));
    cache.set("c", 2, pub()); // replaced without the tag
    expect(cache.invalidateTag("t")).toBe(0);
  });
});

describe("authorization scopes", () => {
  it("never serves one viewer's entry to another viewer or to the public scope", () => {
    const cache = makeCache();
    cache.set("library", ["private-a"], { scope: "user:a" });
    expect(cache.get("library", { scope: "user:b" })).toBeUndefined();
    expect(cache.get("library", pub())).toBeUndefined();
    expect(cache.get("library", { scope: "user:a" })).toEqual(["private-a"]);
  });

  it("keeps same-named keys in different scopes apart", () => {
    const cache = makeCache();
    cache.set("k", 1, { scope: "user:a" });
    cache.set("k", 2, { scope: "user:b" });
    expect(cache.get("k", { scope: "user:a" })).toBe(1);
    expect(cache.get("k", { scope: "user:b" })).toBe(2);
  });

  it("drops a whole viewer scope when their access changes", () => {
    const cache = makeCache();
    cache.set("k1", 1, { scope: "user:a" });
    cache.set("k2", 2, { scope: "user:a" });
    cache.set("k1", 3, { scope: "user:b" });
    expect(cache.invalidateScope("user:a")).toBe(2);
    expect(cache.get("k1", { scope: "user:b" })).toBe(3);
  });

  it("rejects separator characters that could forge another scope's key", () => {
    const cache = makeCache();
    expect(() => cache.set("a\u0000b", 1, pub())).toThrow();
    expect(() => cache.set("a", 1, { scope: "user:a\u0000x" })).toThrow();
  });
});

describe("getOrLoad", () => {
  it("loads once and then serves from cache", async () => {
    const cache = makeCache();
    const loader = vi.fn(async () => ({ id: 1 }));
    expect(await cache.getOrLoad("a", loader, pub())).toMatchObject({ value: { id: 1 }, source: "loader" });
    expect(await cache.getOrLoad("a", loader, pub())).toMatchObject({ value: { id: 1 }, source: "cache" });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("shares a single load between concurrent callers", async () => {
    const cache = makeCache();
    let release;
    const loader = vi.fn(() => new Promise((resolve) => { release = () => resolve("v"); }));
    const calls = [cache.getOrLoad("a", loader, pub()), cache.getOrLoad("a", loader, pub())];
    release();
    const results = await Promise.all(calls);
    expect(results.map((r) => r.value)).toEqual(["v", "v"]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed load and lets the next call retry", async () => {
    const cache = makeCache();
    const loader = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce("ok");
    await expect(cache.getOrLoad("a", loader, pub())).rejects.toThrow("db down");
    expect((await cache.getOrLoad("a", loader, pub())).value).toBe("ok");
    expect(cache.stats().loadFailures).toBe(1);
  });

  it("retries transient failures with exponential backoff", async () => {
    const cache = makeCache();
    const loader = vi.fn().mockRejectedValueOnce(new Error("t1")).mockRejectedValueOnce(new Error("t2")).mockResolvedValueOnce("ok");
    const result = await cache.getOrLoad("a", loader, pub({ retries: 2, retryDelayMs: 10 }));
    expect(result.value).toBe("ok");
    expect(sleeps).toEqual([10, 20]);
    expect(cache.stats().retries).toBe(2);
  });

  it("does not retry errors marked non-retryable", async () => {
    const cache = makeCache();
    const loader = vi.fn().mockRejectedValue(Object.assign(new Error("forbidden"), { retryable: false }));
    await expect(cache.getOrLoad("a", loader, pub({ retries: 3 }))).rejects.toThrow("forbidden");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("serves a within-grace stale entry, flagged, when the reload fails", async () => {
    const cache = makeCache({ defaultTtlMs: 1000, staleGraceMs: 5000 });
    cache.set("a", "old", pub());
    clock += 2000;
    const result = await cache.getOrLoad("a", async () => { throw new Error("down"); }, pub());
    expect(result).toMatchObject({ value: "old", stale: true, source: "stale-cache" });
    expect(cache.stats().staleServed).toBe(1);
  });

  it("fails rather than serving an entry past its grace window, or when stale serving is off", async () => {
    const cache = makeCache({ defaultTtlMs: 1000, staleGraceMs: 5000 });
    cache.set("a", "old", pub());
    clock += 2000;
    const down = async () => { throw new Error("down"); };
    await expect(cache.getOrLoad("a", down, pub({ serveStaleOnError: false }))).rejects.toThrow("down");
    clock += 10_000;
    await expect(cache.getOrLoad("a", down, pub())).rejects.toThrow("down");
  });

  it("never falls back to an entry from an older source version", async () => {
    const cache = makeCache({ defaultTtlMs: 1000, staleGraceMs: 5000 });
    cache.set("a", "v1", pub({ version: 1 }));
    clock += 2000;
    await expect(cache.getOrLoad("a", async () => { throw new Error("down"); }, pub({ version: 2 }))).rejects.toThrow("down");
  });

  it("reloads when the source version changed", async () => {
    const cache = makeCache();
    cache.set("a", "v1", pub({ version: 1 }));
    const result = await cache.getOrLoad("a", async () => "v2", pub({ version: 2 }));
    expect(result).toMatchObject({ value: "v2", source: "loader" });
    expect(cache.lookup("a", pub({ version: 2 })).status).toBe(LookupStatus.HIT);
  });

  it("does not cache a load that raced an invalidation", async () => {
    const cache = makeCache();
    let release;
    const pending = cache.getOrLoad("a", () => new Promise((resolve) => { release = () => resolve("pre-invalidation"); }), pub({ tags: ["t"] }));
    cache.invalidateTag("t");
    release();
    expect((await pending).value).toBe("pre-invalidation");
    expect(cache.get("a", pub())).toBeUndefined();
  });

  it("starts a fresh load after an invalidation instead of joining the old one", async () => {
    const cache = makeCache();
    let release;
    const first = cache.getOrLoad("a", () => new Promise((resolve) => { release = () => resolve("old"); }), pub());
    cache.clear();
    const second = await cache.getOrLoad("a", async () => "new", pub());
    release();
    await first;
    expect(second.value).toBe("new");
    expect(cache.get("a", pub())).toBe("new");
  });
});

describe("stats", () => {
  it("reports hit rate and sizes", () => {
    const cache = makeCache();
    expect(cache.stats().hitRate).toBeNull();
    cache.set("a", 1, pub());
    cache.get("a", pub());
    cache.get("missing", pub());
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, hitRate: 0.5, size: 1, maxEntries: 500 });
  });
});
