import { describe, it, expect, beforeEach } from "vitest";
import { slidingWindowRateLimit, checkRateLimit, resetRateLimits } from "../rateLimit";

/**
 * In-memory mock Redis client simulating ZSET and eval Lua script semantics.
 */
class FakeRedisClient {
  constructor() {
    this.zsets = new Map();
  }

  async eval(script, { keys, arguments: args }) {
    const key = keys[0];
    const now = Number(args[0]);
    const windowMs = Number(args[1]);
    const limit = Number(args[2]);
    const member = args[3];
    const clearBefore = now - windowMs;

    let set = this.zsets.get(key) || [];
    // Remove expired entries
    set = set.filter((entry) => entry.score > clearBefore);

    if (set.length < limit) {
      set.push({ score: now, member });
      this.zsets.set(key, set);
      return [1, limit - set.length, now + windowMs];
    } else {
      const oldest = set[0];
      const resetAt = oldest ? oldest.score + windowMs : now + windowMs;
      this.zsets.set(key, set);
      return [0, 0, resetAt];
    }
  }
}

describe("Redis-backed Sliding Window Rate Limiter (Issue #561)", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("enforces rate limits across multiple instances sharing a Redis client", async () => {
    const sharedRedis = new FakeRedisClient();
    const key = "user:multi-instance-test";
    const windowMs = 60_000;
    const limit = 3;
    const baseNow = 100_000;

    // Instance 1: Request 1 (allowed)
    const r1 = await slidingWindowRateLimit(key, { limit, windowMs, now: baseNow, redisClient: sharedRedis });
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    // Instance 2: Request 2 (allowed)
    const r2 = await slidingWindowRateLimit(key, { limit, windowMs, now: baseNow + 1000, redisClient: sharedRedis });
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    // Instance 1: Request 3 (allowed)
    const r3 = await slidingWindowRateLimit(key, { limit, windowMs, now: baseNow + 2000, redisClient: sharedRedis });
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    // Instance 2: Request 4 (blocked across both instances)
    const r4 = await slidingWindowRateLimit(key, { limit, windowMs, now: baseNow + 3000, redisClient: sharedRedis });
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.retryAfter).toBeGreaterThan(0);
  });

  it("allows new requests once the sliding window slides past old timestamps", async () => {
    const sharedRedis = new FakeRedisClient();
    const key = "user:window-slide-test";
    const windowMs = 5000; // 5 seconds
    const limit = 2;
    const baseNow = 100_000;

    // 2 requests in quick succession
    await slidingWindowRateLimit(key, { limit, windowMs, now: baseNow, redisClient: sharedRedis });
    const r2 = await slidingWindowRateLimit(key, { limit, windowMs, now: baseNow + 1000, redisClient: sharedRedis });
    expect(r2.allowed).toBe(true);

    // 3rd request before window expires is blocked
    const r3 = await slidingWindowRateLimit(key, { limit, windowMs, now: baseNow + 2000, redisClient: sharedRedis });
    expect(r3.allowed).toBe(false);

    // 4th request at baseNow + 5100 (first request has slid out of 5000ms window)
    const r4 = await slidingWindowRateLimit(key, { limit, windowMs, now: baseNow + 5100, redisClient: sharedRedis });
    expect(r4.allowed).toBe(true);
    expect(r4.remaining).toBe(0);
  });

  it("gracefully falls back to in-memory limiter when Redis errors or is unavailable", async () => {
    const faultyRedis = {
      eval: async () => {
        throw new Error("Connection refused");
      },
    };

    const key = "user:fallback-test";
    const windowMs = 60_000;
    const limit = 2;
    const baseNow = 50_000;

    // Should not throw; falls back to in-memory
    const r1 = await slidingWindowRateLimit(key, { limit, windowMs, now: baseNow, redisClient: faultyRedis });
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(1);

    const r2 = await slidingWindowRateLimit(key, { limit, windowMs, now: baseNow + 500, redisClient: faultyRedis });
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(0);

    const r3 = await slidingWindowRateLimit(key, { limit, windowMs, now: baseNow + 1000, redisClient: faultyRedis });
    expect(r3.allowed).toBe(false);
  });

  it("checkRateLimit sync fallback functions properly", () => {
    resetRateLimits();
    expect(checkRateLimit("sync-user", { limit: 1, now: 1000 }).allowed).toBe(true);
    expect(checkRateLimit("sync-user", { limit: 1, now: 1001 }).allowed).toBe(false);
  });
});
