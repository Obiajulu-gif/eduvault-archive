import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getDb: vi.fn(),
  getActorQuotaUsage: vi.fn(),
  resetActorQuota: vi.fn(),
  setActorQuotaOverride: vi.fn(),
  appendAuditRecord: vi.fn(),
}));

vi.mock('@/lib/api/auth', () => ({ requirePermission: mocks.requirePermission }));
vi.mock('@/lib/mongodb', () => ({ getDb: mocks.getDb }));
vi.mock('@/lib/backend/auditLedger', () => ({ appendAuditRecord: mocks.appendAuditRecord }));
vi.mock('@/lib/quotaManager', () => ({
  getActorQuotaUsage: mocks.getActorQuotaUsage,
  QUOTA_RESOURCES: ['storage', 'compute', 'api', 'indexing'],
  resetActorQuota: mocks.resetActorQuota,
  setActorQuotaOverride: mocks.setActorQuotaOverride,
}));

import { GET, POST } from './route';

const jsonRequest = (body) => new Request('http://localhost/api/admin/quotas', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue({ ok: true, user: { sub: 'admin-1' } });
  mocks.getDb.mockResolvedValue({});
  mocks.getActorQuotaUsage.mockResolvedValue({ actorId: 'learner-1', resource: 'storage', used: 20, limit: 100 });
});

describe('/api/admin/quotas authorization and scope', () => {
  it('denies unauthenticated quota reads before touching the database', async () => {
    mocks.requirePermission.mockResolvedValue({ ok: false, status: 401 });

    const response = await GET(new Request('http://localhost/api/admin/quotas?actorId=learner-1'));

    expect(response.status).toBe(401);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it('rejects unknown resources instead of creating an unbounded policy namespace', async () => {
    const response = await POST(jsonRequest({
      actorId: 'learner-1', resource: 'payments', action: 'override', limit: 10, reason: 'temporary allowance',
    }));

    expect(response.status).toBe(400);
    expect(mocks.setActorQuotaOverride).not.toHaveBeenCalled();
    expect(mocks.appendAuditRecord).not.toHaveBeenCalled();
  });

  it('audits an override against only the selected actor and resource', async () => {
    mocks.getActorQuotaUsage
      .mockResolvedValueOnce({ actorId: 'learner-1', resource: 'storage', used: 20, limit: 100 })
      .mockResolvedValueOnce({ actorId: 'learner-1', resource: 'storage', used: 20, limit: 200 });

    const response = await POST(jsonRequest({
      actorId: 'learner-1', resource: 'storage', action: 'override', limit: 200, reason: 'temporary import allowance',
    }));

    expect(response.status).toBe(200);
    expect(mocks.setActorQuotaOverride).toHaveBeenCalledWith({}, 'learner-1', 'storage', 200);
    expect(mocks.appendAuditRecord).toHaveBeenCalledWith(expect.objectContaining({
      actor: 'admin-1',
      action: 'quota.override',
      target: { type: 'actor_quota', actorId: 'learner-1', resource: 'storage' },
      reason: 'temporary import allowance',
      before: { used: 20, limit: 100 },
      after: { used: 20, limit: 200 },
    }));
  });

  it('requires a reason and audits scoped resets', async () => {
    const invalid = await POST(jsonRequest({ actorId: 'learner-1', resource: 'api', action: 'reset' }));
    expect(invalid.status).toBe(400);
    expect(mocks.resetActorQuota).not.toHaveBeenCalled();

    mocks.getActorQuotaUsage
      .mockResolvedValueOnce({ actorId: 'learner-1', resource: 'api', used: 8, limit: 5000 })
      .mockResolvedValueOnce({ actorId: 'learner-1', resource: 'api', used: 0, limit: 5000 });
    const response = await POST(jsonRequest({
      actorId: 'learner-1', resource: 'api', action: 'reset', reason: 'approved usage reset',
    }));

    expect(response.status).toBe(200);
    expect(mocks.resetActorQuota).toHaveBeenCalledWith({}, 'learner-1', 'api');
    expect(mocks.appendAuditRecord).toHaveBeenCalledWith(expect.objectContaining({
      action: 'quota.reset',
      target: { type: 'actor_quota', actorId: 'learner-1', resource: 'api' },
    }));
  });
});
