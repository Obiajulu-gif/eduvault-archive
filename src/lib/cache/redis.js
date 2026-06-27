/**
 * Redis cache utilities for marketplace catalog queries.
 *
 * Provides a lazily-initialised singleton client plus thin helpers for the
 * cache patterns used in this project.  Gracefully degrades to a no-op when
 * REDIS_URL is not configured so the app still works without a Redis sidecar.
 *
 * Required env:
 *   REDIS_URL  — e.g. redis://localhost:6379 or rediss://user:pass@host:port
 */

import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL;
const CATALOG_CACHE_PREFIX = "catalog:";
const CATALOG_TTL_SECONDS = 600; // 10 minutes

let _client = null;

function getClient() {
  if (!REDIS_URL) return null;
  if (!_client) {
    _client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    _client.on("error", (err) => {
      // Log but do not crash — cache errors fall through to the DB.
      console.warn("[redis] connection error:", err.message);
    });
  }
  return _client;
}

/**
 * Returns the cached string value for `key`, or null on miss / error.
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export async function cacheGet(key) {
  try {
    const client = getClient();
    if (!client) return null;
    return await client.get(key);
  } catch {
    return null;
  }
}

/**
 * Stores `value` under `key` with a TTL of `ttl` seconds.
 * Silently skips on error so cache failures never block the response.
 * @param {string} key
 * @param {string} value
 * @param {number} [ttl]
 */
export async function cacheSet(key, value, ttl = CATALOG_TTL_SECONDS) {
  try {
    const client = getClient();
    if (!client) return;
    await client.set(key, value, "EX", ttl);
  } catch {
    // no-op
  }
}

/**
 * Deletes a single cache key.
 * @param {string} key
 */
export async function cacheDel(key) {
  try {
    const client = getClient();
    if (!client) return;
    await client.del(key);
  } catch {
    // no-op
  }
}

/**
 * Builds a stable cache key from a URL search-params object.
 * Sorts params so that `?a=1&b=2` and `?b=2&a=1` share the same entry.
 * @param {URLSearchParams} params
 * @returns {string}
 */
export function buildCatalogCacheKey(params) {
  const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const qs = new URLSearchParams(sorted).toString();
  return `${CATALOG_CACHE_PREFIX}${qs || "_all"}`;
}

/**
 * Deletes all catalog cache keys using a SCAN-based pattern purge.
 * Called after a new public material is created to avoid stale listings.
 */
export async function clearCatalogCache() {
  try {
    const client = getClient();
    if (!client) return;

    const pattern = `${CATALOG_CACHE_PREFIX}*`;
    let cursor = "0";
    do {
      const [next, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = next;
      if (keys.length > 0) {
        await client.del(...keys);
      }
    } while (cursor !== "0");
  } catch {
    // no-op
  }
}
