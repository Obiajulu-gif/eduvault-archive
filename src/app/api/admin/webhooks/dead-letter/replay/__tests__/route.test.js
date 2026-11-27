import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRequireAdmin = vi.fn();
const mockGetDb = vi.fn();
const mockReplayDeadLetterWebhook = vi.fn();
const mockReplayDeadLetterWebhooksBatch = vi.fn();
const mockListDeadLetterWebhooks = vi.fn();

vi.mock('@/lib/api/auth', () => ({
  requireAdmin: (...args) => mockRequireAdmin(...args),
}));

vi.mock('@/lib/mongodb', () => ({
  getDb: (...args) => mockGetDb(...args),
}));

vi.mock('@/lib/webhooks/deadLetterReplay', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    replayDeadLetterWebhook: (...args) => mockReplayDeadLetterWebhook(...args),
    replayDeadLetterWebhooksBatch: (...args) => mockReplayDeadLetterWebhooksBatch(...args),
    listDeadLetterWebhooks: (...args) => mockListDeadLetterWebhooks(...args),
  };
});

import { GET, POST } from '../route';
import { AppError } from '@/lib/errors/AppError';
import { WebhookReplayDeliveryError } from '@/lib/webhooks/deadLetterReplay';

describe('Admin webhook dead-letter replay API route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockResolvedValue({});
  });

  it('returns 401 when caller is not an authenticated admin', async () => {
    mockRequireAdmin.mockResolvedValue(null);

    const req = new Request('http://localhost/api/admin/webhooks/dead-letter/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' },
      body: JSON.stringify({ entryId: 'entry-1' }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 when idempotency key is missing', async () => {
    mockRequireAdmin.mockResolvedValue({ sub: 'admin-1', role: 'admin' });

    const req = new Request('http://localhost/api/admin/webhooks/dead-letter/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entryId: 'entry-1' }),
    });

    const res = await POST(req);
    const data = await res.json();
    expect(res.status).toBe(400);
    expect(data.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  it('returns 200 on successful single replay', async () => {
    mockRequireAdmin.mockResolvedValue({ sub: 'admin-1', role: 'admin' });
    mockReplayDeadLetterWebhook.mockResolvedValue({
      entryId: 'entry-1',
      status: 'delivered',
      deliveredUrls: ['https://creator.example/hook'],
      replayed: false,
    });

    const req = new Request('http://localhost/api/admin/webhooks/dead-letter/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'replay-1' },
      body: JSON.stringify({ entryId: 'entry-1' }),
    });

    const res = await POST(req);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.status).toBe('delivered');
  });

  it('maps idempotency conflict to 409 and delivery failure to 502', async () => {
    mockRequireAdmin.mockResolvedValue({ sub: 'admin-1', role: 'admin' });

    mockReplayDeadLetterWebhook.mockRejectedValueOnce(
      new AppError('CONFLICT_IN_PROGRESS', { details: { idempotencyKey: 'k1' } })
    );
    const conflictReq = new Request('http://localhost/api/admin/webhooks/dead-letter/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' },
      body: JSON.stringify({ entryId: 'entry-1' }),
    });
    const conflictRes = await POST(conflictReq);
    expect(conflictRes.status).toBe(409);

    mockReplayDeadLetterWebhook.mockRejectedValueOnce(
      new WebhookReplayDeliveryError('Downstream 503')
    );
    const failReq = new Request('http://localhost/api/admin/webhooks/dead-letter/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k2' },
      body: JSON.stringify({ entryId: 'entry-1' }),
    });
    const failRes = await POST(failReq);
    expect(failRes.status).toBe(502);
  });

  it('lists dead-letter webhooks on GET for authorized admin', async () => {
    mockRequireAdmin.mockResolvedValue({ sub: 'admin-1', role: 'admin' });
    mockListDeadLetterWebhooks.mockResolvedValue({ items: [{ _id: 'entry-1' }], count: 1, limit: 25, skip: 0 });

    const req = new Request('http://localhost/api/admin/webhooks/dead-letter/replay?limit=10');
    const res = await GET(req);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.count).toBe(1);
  });
});
