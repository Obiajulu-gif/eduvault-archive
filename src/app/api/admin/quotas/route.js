import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/api/auth';
import { sanitizeString } from '@/lib/api/validation';
import { appendAuditRecord } from '@/lib/backend/auditLedger';
import { getDb } from '@/lib/mongodb';
import {
  getActorQuotaUsage,
  QUOTA_RESOURCES,
  resetActorQuota,
  setActorQuotaOverride,
} from '@/lib/quotaManager';

function authorize(request, permission) {
  return requirePermission(request, permission);
}

function parseScope(actorId, resource) {
  if (typeof actorId !== 'string' || typeof resource !== 'string') return null;
  const normalizedActorId = sanitizeString(actorId, { maxLength: 200 });
  const normalizedResource = sanitizeString(resource, { maxLength: 32 });
  if (!normalizedActorId || !normalizedResource || !QUOTA_RESOURCES.includes(normalizedResource)) {
    return null;
  }
  return { actorId: normalizedActorId, resource: normalizedResource };
}

export async function GET(request) {
  const authorization = await authorize(request, 'admin:access');
  if (!authorization.ok) {
    return NextResponse.json({ error: 'Admin access required' }, { status: authorization.status });
  }

  const { searchParams } = new URL(request.url);
  const scope = parseScope(searchParams.get('actorId'), searchParams.get('resource') || 'storage');
  if (!scope) {
    return NextResponse.json({ error: 'A valid actorId and resource are required' }, { status: 400 });
  }

  try {
    const usage = await getActorQuotaUsage(await getDb(), scope.actorId, scope.resource);
    return NextResponse.json(usage);
  } catch (error) {
    console.error('[admin/quotas] GET failed:', error);
    return NextResponse.json({ error: 'Unable to read quota information' }, { status: 500 });
  }
}

export async function POST(request) {
  const authorization = await authorize(request, 'admin:access');
  if (!authorization.ok) {
    return NextResponse.json({ error: 'Admin access required' }, { status: authorization.status });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'A valid JSON body is required' }, { status: 400 });
  }

  const scope = parseScope(body?.actorId, body?.resource);
  if (!scope || !['reset', 'override'].includes(body?.action)) {
    return NextResponse.json({ error: 'A valid actorId, resource, and action are required' }, { status: 400 });
  }
  if (body.action === 'override' && (!Number.isSafeInteger(body.limit) || body.limit < -1)) {
    return NextResponse.json({ error: 'limit must be a non-negative integer or -1 for unlimited' }, { status: 400 });
  }
  const reason = sanitizeString(body.reason, { maxLength: 500 });
  if (reason.length < 8) {
    return NextResponse.json({ error: 'A reason of at least 8 characters is required' }, { status: 400 });
  }

  try {
    const db = await getDb();
    const before = await getActorQuotaUsage(db, scope.actorId, scope.resource);
    const after = body.action === 'override'
      ? { ...before, limit: body.limit }
      : { ...before, used: 0 };

    // Write the immutable audit record before applying the requested change. If
    // the audit store is unavailable, the policy mutation is not performed.
    await appendAuditRecord({
      db,
      operationId: `quota:${randomUUID()}`,
      actor: authorization.user.sub || authorization.user._id,
      action: `quota.${body.action}`,
      target: { type: 'actor_quota', actorId: scope.actorId, resource: scope.resource },
      reason,
      intent: { action: body.action, scope, ...(body.action === 'override' ? { limit: body.limit } : {}) },
      before: { limit: before.limit, used: before.used },
      after: { limit: after.limit, used: after.used },
      result: { status: 'authorized_request' },
    });

    if (body.action === 'reset') {
      await resetActorQuota(db, scope.actorId, scope.resource);
    } else {
      await setActorQuotaOverride(db, scope.actorId, scope.resource, body.limit);
    }
    return NextResponse.json({ success: true, scope, usage: await getActorQuotaUsage(db, scope.actorId, scope.resource) });
  } catch (error) {
    console.error('[admin/quotas] POST failed:', error);
    return NextResponse.json({ error: 'Unable to apply quota policy change; check the quota audit log before retrying' }, { status: 500 });
  }
}
