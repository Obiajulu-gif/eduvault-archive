import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
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
  let mongo;
  let client;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    client = new MongoClient(mongo.getUri());
    await client.connect();
    db = client.db('quota-tests');
    await db.collection('actor_quotas').createIndex({ actorId: 1, resource: 1 }, { unique: true });
    await db.collection('actor_quota_usage').createIndex({ actorId: 1, resource: 1 }, { unique: true });
  });

  afterAll(async () => {
    await client?.close();
    await mongo?.stop();
  });

  beforeEach(async () => {
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

  it('does not let concurrent requests increment usage past the scoped limit', async () => {
    const actorId = 'concurrent-user';
    const resource = 'compute';
    await setActorQuotaOverride(db, actorId, resource, 100);
    await consumeActorQuota(db, actorId, resource, 80);

    const results = await Promise.allSettled([
      consumeActorQuota(db, actorId, resource, 11),
      consumeActorQuota(db, actorId, resource, 11),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await getActorQuotaUsage(db, actorId, resource)).used).toBe(91);
  });

  it('returns a safe error with remediation without exposing the actor id', async () => {
    const actorId = 'private-user-123';
    await setActorQuotaOverride(db, actorId, 'indexing', 1);
    await consumeActorQuota(db, actorId, 'indexing', 1);

    let error;
    try {
      await consumeActorQuota(db, actorId, 'indexing', 1);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      name: 'UserQuotaError',
      status: 429,
      resource: 'indexing',
      message: expect.stringMatching(/Reduce current usage or contact support/),
    });
    expect(error.message).not.toContain(actorId);
  });

  it('rejects missing actors, unknown resources, and invalid amounts', async () => {
    await expect(consumeActorQuota(db, '', 'storage', 1)).rejects.toThrow(/actorId/);
    await expect(consumeActorQuota(db, 'user1', 'unknown', 1)).rejects.toThrow(/Unsupported quota resource/);
    await expect(consumeActorQuota(db, 'user1', 'storage', 0)).rejects.toThrow(/positive safe integer/);
  });
});
