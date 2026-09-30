import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '@/lib/mongodb';
import {
  assertActorQuota,
  consumeActorQuota,
  resetActorQuota,
  setActorQuotaOverride,
  getActorQuotaUsage,
  UserQuotaError
} from '@/lib/quotaManager';

describe('quotaManager', () => {
  let db;

  beforeEach(async () => {
    db = await getDb();
    await db.collection('actor_quotas').deleteMany({});
    await db.collection('actor_quota_usage').deleteMany({});
  });

  it('allows usage within limits', async () => {
    const actorId = 'user1';
    const resource = 'storage';
    
    await consumeActorQuota(db, actorId, resource, 100);
    
    const usage = await getActorQuotaUsage(db, actorId, resource);
    expect(usage.used).toBe(100);
    expect(usage.limit).toBe(500 * 1024 * 1024);
  });

  it('blocks usage when over limit', async () => {
    const actorId = 'user2';
    const resource = 'indexing';
    
    // Default limit is 100. Consume 90, then try 20.
    await consumeActorQuota(db, actorId, resource, 90);
    
    await expect(consumeActorQuota(db, actorId, resource, 20)).rejects.toThrow(UserQuotaError);
    
    const usage = await getActorQuotaUsage(db, actorId, resource);
    expect(usage.used).toBe(90);
  });

  it('resets quota usage', async () => {
    const actorId = 'user3';
    const resource = 'api';
    
    await consumeActorQuota(db, actorId, resource, 500);
    await resetActorQuota(db, actorId, resource);
    
    const usage = await getActorQuotaUsage(db, actorId, resource);
    expect(usage.used).toBe(0);
  });

  it('respects override limits', async () => {
    const actorId = 'user4';
    const resource = 'compute';
    
    // Set limit lower than default
    await setActorQuotaOverride(db, actorId, resource, 50);
    
    await consumeActorQuota(db, actorId, resource, 40);
    await expect(consumeActorQuota(db, actorId, resource, 20)).rejects.toThrow(UserQuotaError);
    
    const usage = await getActorQuotaUsage(db, actorId, resource);
    expect(usage.limit).toBe(50);
  });

  it('allows infinite usage with -1 override', async () => {
    const actorId = 'user5';
    const resource = 'storage';
    
    await setActorQuotaOverride(db, actorId, resource, -1);
    
    // Default limit is 500MB, try to consume 1GB
    await consumeActorQuota(db, actorId, resource, 1024 * 1024 * 1024);
    
    const usage = await getActorQuotaUsage(db, actorId, resource);
    expect(usage.used).toBe(1024 * 1024 * 1024);
    expect(usage.limit).toBe(-1);
  });
});
