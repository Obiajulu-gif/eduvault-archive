export class UserQuotaError extends Error {
  constructor(message, resource, actor) {
    super(message)
    this.name = 'UserQuotaError'
    this.status = 429
    this.resource = resource
    this.actor = actor
  }
}

const DEFAULT_QUOTAS = {
  storage: 500 * 1024 * 1024, // 500MB
  compute: 1000, 
  api: 5000, 
  indexing: 100
};

export async function assertActorQuota(db, actorId, resource, amount = 1) {
  if (!actorId) return;
  
  const actorConfig = await db.collection('actor_quotas').findOne({ actorId, resource });
  
  const limit = actorConfig?.limit ?? DEFAULT_QUOTAS[resource] ?? 0;
  
  if (limit === -1) return; // -1 means infinite/override
  
  const usageDoc = await db.collection('actor_quota_usage').findOne({ actorId, resource });
  const currentUsage = usageDoc?.used ?? 0;
  
  if (currentUsage + amount > limit) {
    throw new UserQuotaError(`Quota exceeded for resource: ${resource}`, resource, actorId);
  }
}

export async function consumeActorQuota(db, actorId, resource, amount = 1) {
  if (!actorId) return;
  await assertActorQuota(db, actorId, resource, amount);
  
  await db.collection('actor_quota_usage').updateOne(
    { actorId, resource },
    { $inc: { used: amount } },
    { upsert: true }
  );
}

export async function resetActorQuota(db, actorId, resource) {
  await db.collection('actor_quota_usage').updateOne(
    { actorId, resource },
    { $set: { used: 0 } }
  );
}

export async function setActorQuotaOverride(db, actorId, resource, limit) {
  await db.collection('actor_quotas').updateOne(
    { actorId, resource },
    { $set: { limit } },
    { upsert: true }
  );
}

export async function getActorQuotaUsage(db, actorId, resource) {
  const usageDoc = await db.collection('actor_quota_usage').findOne({ actorId, resource });
  const actorConfig = await db.collection('actor_quotas').findOne({ actorId, resource });
  return {
    actorId,
    resource,
    used: usageDoc?.used ?? 0,
    limit: actorConfig?.limit ?? DEFAULT_QUOTAS[resource] ?? 0
  };
}
