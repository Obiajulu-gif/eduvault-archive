async function getRedis() {
  try {
    const mod = await import('../cache/redis.js');
    return mod.getRedisClient();
  } catch {
    return null;
  }
}

const inMemoryBuckets = new Map();

/**
 * In-memory sliding window rate limiter fallback.
 */
function inMemorySlidingWindow(bucketKey, limit, windowMs, now) {
  let timestamps = inMemoryBuckets.get(bucketKey) || [];
  const windowStart = now - windowMs;
  timestamps = timestamps.filter((ts) => ts > windowStart);

  if (timestamps.length < limit) {
    timestamps.push(now);
    inMemoryBuckets.set(bucketKey, timestamps);
    const resetAt = timestamps[0] + windowMs;
    return {
      allowed: true,
      remaining: limit - timestamps.length,
      resetAt,
      retryAfter: Math.max(0, Math.ceil((resetAt - now) / 1000)),
    };
  }

  const resetAt = timestamps[0] + windowMs;
  return {
    allowed: false,
    remaining: 0,
    resetAt,
    retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)),
  };
}

/**
 * Atomic sliding-window rate limit check backed by Redis, with graceful
 * in-memory fallback when Redis is unavailable or unconfigured.
 *
 * @param {string} key - Rate limit bucket identifier
 * @param {object} [options]
 * @param {number} [options.limit=60] - Max requests allowed in the window
 * @param {number} [options.windowMs=60000] - Window duration in milliseconds
 * @param {number} [options.now=Date.now()] - Current epoch timestamp in ms
 * @param {object} [options.redisClient=null] - Optional injected Redis client for multi-instance tests
 * @returns {Promise<{allowed: boolean, remaining: number, resetAt: number, retryAfter: number}>}
 */
export async function slidingWindowRateLimit(key, { limit = 60, windowMs = 60_000, now = Date.now(), redisClient = null } = {}) {
  const bucketKey = String(key || "anonymous");
  const redisKey = `ratelimit:${bucketKey}`;

  let client = redisClient;
  if (!client) {
    try {
      client = await getRedis();
    } catch (err) {
      console.warn("Redis rate limit client error, falling back to in-memory:", err.message);
      client = null;
    }
  }

  if (client) {
    try {
      const member = `${now}-${Math.random().toString(36).substring(2, 9)}`;
      const script = `
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local windowMs = tonumber(ARGV[2])
        local limit = tonumber(ARGV[3])
        local member = ARGV[4]
        local clearBefore = now - windowMs

        redis.call('ZREMRANGEBYSCORE', key, '-inf', clearBefore)
        local currentRequests = tonumber(redis.call('ZCARD', key))

        if currentRequests < limit then
            redis.call('ZADD', key, now, member)
            redis.call('PEXPIRE', key, windowMs)
            return {1, limit - currentRequests - 1, now + windowMs}
        else
            local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
            local resetAt = now + windowMs
            if oldest and #oldest >= 2 then
                resetAt = tonumber(oldest[2]) + windowMs
            end
            return {0, 0, resetAt}
        end
      `;

      let result;
      if (typeof client.eval === 'function') {
        result = await client.eval(script, {
          keys: [redisKey],
          arguments: [String(now), String(windowMs), String(limit), member],
        });
      } else if (typeof client.evalRaw === 'function') {
        result = await client.evalRaw([script, 1, redisKey, String(now), String(windowMs), String(limit), member]);
      }

      if (Array.isArray(result)) {
        const allowed = Number(result[0]) === 1;
        const remaining = Number(result[1]);
        const resetAt = Number(result[2]);
        const retryAfter = allowed ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1000));

        return { allowed, remaining, resetAt, retryAfter };
      }
    } catch (err) {
      console.warn("Redis rate limit execution error, falling back to in-memory:", err.message);
    }
  }

  return inMemorySlidingWindow(bucketKey, limit, windowMs, now);
}

/**
 * Synchronous / backward-compatible checkRateLimit function.
 */
export function checkRateLimit(key, options = {}) {
  const bucketKey = String(key || "anonymous");
  const { limit = 60, windowMs = 60_000, now = Date.now() } = options;
  return inMemorySlidingWindow(bucketKey, limit, windowMs, now);
}

export function resetRateLimits() {
  inMemoryBuckets.clear();
}
