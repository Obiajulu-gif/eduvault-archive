/**
 * Sliding-window in-memory rate limiter.
 *
 * Stores per-key request timestamps within the current window and prunes
 * entries older than windowMs on every call. Safe for Next.js Edge/Node
 * runtimes where a single-process Map is sufficient.
 */

const windows = new Map();

/**
 * @param {string} key       Unique identifier for this client + route combination
 * @param {Object} options
 * @param {number} options.limit     Maximum requests allowed within windowMs
 * @param {number} options.windowMs  Window size in milliseconds
 * @param {number} [options.now]     Current timestamp (injectable for tests)
 * @returns {{ allowed: boolean, limit: number, remaining: number, resetAt: number, retryAfter?: number }}
 */
export function slidingWindowRateLimit(key, { limit = 60, windowMs = 60_000, now = Date.now() } = {}) {
  const windowStart = now - windowMs;

  const timestamps = windows.get(key) ?? [];
  const valid = timestamps.filter((t) => t > windowStart);

  if (valid.length >= limit) {
    // Next slot opens when the oldest timestamp in the window expires
    const resetAt = valid[0] + windowMs;
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetAt,
      retryAfter: Math.ceil((resetAt - now) / 1000),
    };
  }

  valid.push(now);
  windows.set(key, valid);

  return {
    allowed: true,
    limit,
    remaining: limit - valid.length,
    resetAt: now + windowMs,
  };
}

export function resetSlidingWindows() {
  windows.clear();
}
// Issue 423: Rate limiting applied to API routes
