import { createClient } from 'redis';

let client = null;

export async function getRedisClient() {
  if (!process.env.REDIS_URL) return null;
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (err) => console.error('Redis error', err.message));
    await client.connect();
  }
  return client;
}

export async function cacheGet(key) {
  const redis = await getRedisClient();
  if (!redis) return null;
  try {
    const val = await redis.get(key);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}

export async function cacheSet(key, value, ttlSeconds = 600) {
  const redis = await getRedisClient();
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), { EX: ttlSeconds });
  } catch { /* no-op */ }
}

export async function cacheDel(key) {
  const redis = await getRedisClient();
  if (!redis) return;
  try { await redis.del(key); } catch { /* no-op */ }
}

const CATALOG_REVISION_KEY = 'market-materials:revision';

export async function catalogCacheKey(query) {
  const redis = await getRedisClient();
  let revision = '0';
  if (redis) {
    try { revision = (await redis.get(CATALOG_REVISION_KEY)) || '0'; } catch { /* fallback */ }
  }
  return `market-materials:v${revision}:${query}`;
}

export async function invalidateCatalogCache() {
  const redis = await getRedisClient();
  if (!redis) return;
  try { await redis.incr(CATALOG_REVISION_KEY); } catch { /* TTL still bounds stale entries */ }
}
