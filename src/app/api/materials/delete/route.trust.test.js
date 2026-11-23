// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../../../tests/fixtures/trustDb.mjs';
import { digest } from '@/lib/backend/trustRecords';
import { POLICIES, recordConsent } from '@/lib/backend/consentLedger';
import { resolveFraudReview } from '@/lib/backend/fraudReview';
import { POST } from './route';

const mocks = vi.hoisted(() => ({ db: null, user: null, mutate: vi.fn() }));
vi.mock('@/lib/mongodb', () => ({ getDb: async () => mocks.db }));
vi.mock('@/lib/api/auth', () => ({ requireAdmin: async () => null,
  requireActiveUser: async () => ({ ok: true, user: mocks.user }) }));
vi.mock('@/lib/db/softDelete', () => ({ softDeleteMaterial: (...args) => mocks.mutate(...args), restoreMaterial: (...args) => mocks.mutate(...args) }));
vi.mock('@/lib/api/audit', () => ({ auditLog: vi.fn() }));
vi.mock('@/lib/db/adminAudit', () => ({ recordAdminAction: vi.fn() }));
vi.mock('@/lib/backend/materialSearchProjection', () => ({ enqueueMaterialSearchProjection: vi.fn() }));
vi.mock('@/lib/cache/redis', () => ({ invalidateCatalogCache: vi.fn() }));
vi.mock('@/lib/backend/auditLedger', () => ({ appendCriticalMutation: vi.fn() }));

describe('catalog mutation trust gates', () => {
  let material;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db = fakeDb();
    mocks.user = { _id: 'student', sub: 'student', walletAddress: 'Glinked' };
    material = { _id: 'asset', materialId: 'asset', searchVersion: 2, userAddress: 'Glinked', status: 'active' };
    mocks.db.collection('materials').findOne = async () => material;
    mocks.mutate.mockResolvedValue({ ok: true, material, updatedMaterial: { ...material, isDeleted: true } });
  });
  const request = (extra = {}) => new Request('https://eduvault.test/api/materials/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ materialId: 'asset', ...extra }),
  });
  const accept = () => recordConsent({ db: mocks.db, user: mocks.user, policyKey: 'catalog-management:1',
    versionHash: digest(POLICIES['catalog-management:1']), decision: 'accepted' });

  it('missing consent blocks execution; accepted consent allows low-risk mutation', async () => {
    expect((await POST(request())).status).toBe(428);
    expect(mocks.mutate).not.toHaveBeenCalled();
    await accept();
    expect((await POST(request())).status).toBe(200);
    expect(mocks.mutate).toHaveBeenCalledOnce();
    expect(mocks.mutate.mock.calls[0][0].expectedFields).toMatchObject({ searchVersion: 2, status: 'active' });
  });
  it('queued review and rejection block execution before side effects', async () => {
    await accept();
    mocks.user.securityReviewRequired = true;
    const queued = await POST(request());
    expect(queued.status).toBe(409);
    const { reviewId } = await queued.json();
    await resolveFraudReview({ db: mocks.db, user: { sub: 'admin', role: 'admin' }, id: reviewId, decision: 'rejected', reason: 'confirmed' });
    expect((await POST(request())).status).toBe(409);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('approved review still requires independent step-up verification', async () => {
    await accept();
    mocks.user.securityReviewRequired = true;
    const { reviewId } = await (await POST(request())).json();
    await resolveFraudReview({ db: mocks.db, user: { sub: 'admin', role: 'admin' }, id: reviewId, decision: 'approved', reason: 'checked' });
    const response = await POST(request());
    expect(response.status).toBe(428);
    expect((await response.json()).code).toBe('STEP_UP_REQUIRED');
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
