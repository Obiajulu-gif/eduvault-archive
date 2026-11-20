// @vitest-environment node
//
// #1146: ownership-transfer routes answer auth and validation failures with
// stable problem-details codes, keeping the legacy `error` string.
import { describe, it, expect, vi } from 'vitest';

const { currentAuth } = vi.hoisted(() => ({ currentAuth: { value: null } }));

vi.mock('@/lib/api/auth', () => ({ requirePermission: vi.fn(async () => currentAuth.value) }));
vi.mock('@/lib/api/hardening', () => ({ withApiHardening: vi.fn((req, options, handler) => handler()) }));
vi.mock('@/lib/mongodb', () => ({ getDb: vi.fn(async () => ({})) }));
vi.mock('@/lib/api/audit', () => ({ auditLog: vi.fn() }));
vi.mock('@/lib/cache/redis', () => ({ invalidateCatalogCache: vi.fn() }));
vi.mock('@/lib/backend/materialSearchProjection', () => ({ enqueueMaterialSearchProjection: vi.fn() }));

import { GET as list } from '../route';
import { POST as act } from '../[transferId]/route';

const listRequest = () => new Request('http://localhost/api/ownership-transfers');
const actRequest = (body) =>
  new Request('http://localhost/api/ownership-transfers/t-1', { method: 'POST', body: JSON.stringify(body) });

async function problem(response) {
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  return response.json();
}

describe('ownership-transfer problem details', () => {
  it('returns AUTH_UNAUTHENTICATED without a session', async () => {
    currentAuth.value = { ok: false, status: 401 };
    const response = await list(listRequest());
    expect(response.status).toBe(401);
    expect(await problem(response)).toMatchObject({ code: 'AUTH_UNAUTHENTICATED', error: 'Authentication required' });
  });

  it('returns AUTH_FORBIDDEN without creator permission', async () => {
    currentAuth.value = { ok: false, status: 403 };
    const response = await act(actRequest({ action: 'accept' }), { params: { transferId: 't-1' } });
    expect(response.status).toBe(403);
    expect(await problem(response)).toMatchObject({ code: 'AUTH_FORBIDDEN', retryable: false });
  });

  it('returns VALIDATION_FIELD for an unknown action', async () => {
    currentAuth.value = { ok: true, user: { sub: 'u-1', walletAddress: 'GOWNER' } };
    const response = await act(actRequest({ action: 'steal' }), { params: { transferId: 't-1' } });
    expect(response.status).toBe(400);
    expect(await problem(response)).toMatchObject({ code: 'VALIDATION_FIELD' });
  });
});
