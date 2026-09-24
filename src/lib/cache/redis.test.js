import { beforeEach, describe, expect, it, vi } from 'vitest'

const redis = { get: vi.fn(), incr: vi.fn() }
vi.mock('redis', () => ({ createClient: () => ({ ...redis, on: vi.fn(), connect: vi.fn() }) }))

describe('catalog cache generations', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env.REDIS_URL = 'redis://test'
  })

  it('changes catalog keys after explicit invalidation', async () => {
    redis.get.mockResolvedValueOnce('4').mockResolvedValueOnce('5')
    const { catalogCacheKey, invalidateCatalogCache } = await import('./redis')
    expect(await catalogCacheKey('page=1')).toBe('market-materials:v4:page=1')
    await invalidateCatalogCache()
    expect(redis.incr).toHaveBeenCalledWith('market-materials:revision')
    expect(await catalogCacheKey('page=1')).toBe('market-materials:v5:page=1')
  })
})
