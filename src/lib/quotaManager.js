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

export const QUOTA_RESOURCES = Object.freeze(Object.keys(DEFAULT_QUOTAS));

function validateScope(actorId, resource) {
  if (typeof actorId !== 'string' || !actorId.trim()) {
    throw new TypeError('Quota actorId must be a non-empty string');
  }
  if (!QUOTA_RESOURCES.includes(resource)) {
    throw new TypeError(`Unsupported quota resource: ${String(resource)}`);
  }
}

function validateAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new TypeError('Quota amount must be a positive safe integer');
  }
}

export async function assertActorQuota(db, actorId, resource, amount = 1) {
  validateScope(actorId, resource);
  validateAmount(amount);
  
  const actorConfig = await db.collection('actor_quotas').findOne({ actorId, resource });
  
  const limit = actorConfig?.limit ?? DEFAULT_QUOTAS[resource] ?? 0;
  
  if (limit === -1) return; // -1 means infinite/override
  
  const usageDoc = await db.collection('actor_quota_usage').findOne({ actorId, resource });
  const currentUsage = usageDoc?.used ?? 0;
  
  if (currentUsage + amount > limit) {
    throw new UserQuotaError(
      `The ${resource} limit has been reached. Reduce current usage or contact support to request a scoped limit change.`,
      resource,
      actorId
    );
  }
}

export async function consumeActorQuota(db, actorId, resource, amount = 1) {
  validateScope(actorId, resource);
  validateAmount(amount);

  const actorConfig = await db.collection('actor_quotas').findOne({ actorId, resource });
  const limit = actorConfig?.limit ?? DEFAULT_QUOTAS[resource] ?? 0;
  const usage = db.collection('actor_quota_usage');

  // Seed the scoped counter once, then enforce the limit in the same atomic
  // update that increments it. This prevents concurrent requests from both
  // passing a stale read and exceeding the actor/resource policy.
  try {
    await usage.updateOne(
      { actorId, resource },
      { $setOnInsert: { used: 0 } },
      { upsert: true }
    );
  } catch (error) {
    // Another first-use request may win the unique scoped insert race.
    if (error?.code !== 11000) throw error;
  }
  const filter = { actorId, resource };
  if (limit !== -1) filter.used = { $lte: limit - amount };
  const result = await usage.updateOne(filter, { $inc: { used: amount } });
  if (result.matchedCount === 0 && limit !== -1) {
    throw new UserQuotaError(
      `The ${resource} limit has been reached. Reduce current usage or contact support to request a scoped limit change.`,
      resource,
      actorId
    );
  }
}

export async function resetActorQuota(db, actorId, resource) {
  validateScope(actorId, resource);
  await db.collection('actor_quota_usage').updateOne(
    { actorId, resource },
    { $set: { used: 0 } }
  );
}

export async function setActorQuotaOverride(db, actorId, resource, limit) {
  validateScope(actorId, resource);
  if (!Number.isSafeInteger(limit) || limit < -1) {
    throw new TypeError('Quota override must be a non-negative safe integer or -1');
  }
  await db.collection('actor_quotas').updateOne(
    { actorId, resource },
    { $set: { limit } },
    { upsert: true }
  );
}

export async function getActorQuotaUsage(db, actorId, resource) {
  validateScope(actorId, resource);
  const usageDoc = await db.collection('actor_quota_usage').findOne({ actorId, resource });
  const actorConfig = await db.collection('actor_quotas').findOne({ actorId, resource });
  return {
    actorId,
    resource,
    used: usageDoc?.used ?? 0,
    limit: actorConfig?.limit ?? DEFAULT_QUOTAS[resource] ?? 0
  };
}
