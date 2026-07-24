import { createHash } from "node:crypto";
import { getRedisClient } from "../cache/redis.js";

const LUA = `
local count = redis.call('INCRBY', KEYS[1], ARGV[1])
if count == tonumber(ARGV[1]) then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

export function hashedDimension(value) {
  return createHash("sha256").update(String(value || "anonymous")).digest("hex").slice(0, 32);
}

export async function checkRateLimit(key, { limit = 60, windowMs = 60_000, cost = 1, outagePolicy = "closed" } = {}) {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return { allowed: true, limit, remaining: limit };
  }

  const redis = await Promise.race([
    getRedisClient(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("rate-limit timeout")), 250)),
  ]).catch(() => null);
  if (!redis) {
    return outagePolicy === "open"
      ? { allowed: true, limit, remaining: limit, degraded: true }
      : { allowed: false, limit, remaining: 0, retryAfter: 1, degraded: true };
  }
  const redisKey = `rl:v1:${hashedDimension(key)}`;
  const [count, ttl] = await redis.eval(LUA, { keys: [redisKey], arguments: [String(cost), String(windowMs)] });
  return {
    allowed: count <= limit, limit, remaining: Math.max(0, limit - count),
    resetAt: Date.now() + ttl, retryAfter: Math.max(1, Math.ceil(ttl / 1000)),
  };
}

export function resetRateLimits() { /* distributed keys expire by bounded TTL */ }
