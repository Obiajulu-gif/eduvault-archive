import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '../route';
import { verifyCapabilityToken } from '@/lib/downloads/capabilityToken';

const {
  mockGetUserFromCookie,
  mockAuthorizeMaterialAccess,
  mockGetDb,
  mockRecordDownloadAccess,
} = vi.hoisted(() => ({
  mockGetUserFromCookie: vi.fn(),
  mockAuthorizeMaterialAccess: vi.fn(),
  mockGetDb: vi.fn(),
  mockRecordDownloadAccess: vi.fn(),
}));

vi.mock('@/lib/api/auth', () => ({ getUserFromCookie: mockGetUserFromCookie }));
vi.mock('@/lib/entitlement', () => ({ authorizeMaterialAccess: mockAuthorizeMaterialAccess }));
vi.mock('@/lib/mongodb', () => ({ getDb: mockGetDb }));
vi.mock('@/lib/downloads/accessLog', () => ({ recordDownloadAccess: mockRecordDownloadAccess }));

const BUYER = 'gbuyer123';
const MATERIAL_ID = 'material-1';

function fakeMaterialsCollection(material) {
  return {
    findOne: async () => material,
  };
}

function makeRequest({ materialId = MATERIAL_ID, buyerAddress, range, nonce } = {}) {
  const params = new URLSearchParams();
  if (materialId) params.set('materialId', materialId);
  if (buyerAddress) params.set('buyerAddress', buyerAddress);
  if (range) params.set('range', range);
  if (nonce) params.set('nonce', nonce);
  return new Request(`http://localhost:3000/api/download?${params.toString()}`);
}

describe('GET /api/download (#675)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetUserFromCookie.mockResolvedValue({ walletAddress: BUYER });
    mockAuthorizeMaterialAccess.mockResolvedValue({ allowed: true, source: 'chain', httpStatus: 200 });
    mockGetDb.mockResolvedValue({
      collection: (name) => {
        if (name === 'materials') {
          return fakeMaterialsCollection({
            materialId: MATERIAL_ID,
            ipfsCid: 'QmTestCid',
            fileName: 'lecture.pdf',
            contentType: 'application/pdf',
          });
        }
        throw new Error(`Unexpected collection: ${name}`);
      },
    });
    mockRecordDownloadAccess.mockResolvedValue(undefined);
  });

  it('returns 401 when there is no session', async () => {
    mockGetUserFromCookie.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('returns 400 when materialId is missing', async () => {
    const res = await GET(makeRequest({ materialId: '' }));
    expect(res.status).toBe(400);
  });

  it('returns 403 when the buyerAddress query param does not match the session', async () => {
    const res = await GET(makeRequest({ buyerAddress: 'someone-else' }));
    expect(res.status).toBe(403);
  });

  it('returns the entitlement-policy status code and logs a denial when access is not allowed', async () => {
    mockAuthorizeMaterialAccess.mockResolvedValue({ allowed: false, state: 'not_entitled', httpStatus: 402 });

    const res = await GET(makeRequest());
    expect(res.status).toBe(402);

    expect(mockRecordDownloadAccess).toHaveBeenCalledTimes(1);
    const [, entry] = mockRecordDownloadAccess.mock.calls[0];
    expect(entry.event).toBe('access_denied');
    expect(entry.denialReason).toBe('not_entitled');
    expect(entry.buyerAddress).toBe(BUYER);
  });

  it('issues a verifiable, signed capability URL and logs the issuance', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.fileUrl).toContain('/ipfs/QmTestCid?');
    expect(body.fileUrl).toContain('cap=');
    // The old implementation also echoed the raw token back in a
    // `capability.token` field — no reason for the client to receive it
    // twice, and one fewer place it can leak from.
    expect(body.capability.token).toBeUndefined();

    const capUrl = new URL(body.fileUrl);
    const capToken = capUrl.searchParams.get('cap');
    const verification = verifyCapabilityToken(capToken, { buyerAddress: BUYER, materialId: MATERIAL_ID });
    expect(verification.valid).toBe(true);

    expect(mockRecordDownloadAccess).toHaveBeenCalledTimes(1);
    const [, entry] = mockRecordDownloadAccess.mock.calls[0];
    expect(entry.event).toBe('capability_issued');
    expect(entry.capabilityId).toBe(verification.payload.jti);
    // The access log entry must never carry the token or the URL it's embedded in.
    expect(JSON.stringify(entry)).not.toContain(capToken);
  });

  it('binds the byte range from the query param into the signed token', async () => {
    const res = await GET(makeRequest({ range: '0-1023' }));
    const body = await res.json();

    const capUrl = new URL(body.fileUrl);
    const capToken = capUrl.searchParams.get('cap');
    const verification = verifyCapabilityToken(capToken, { buyerAddress: BUYER, materialId: MATERIAL_ID });
    expect(verification.valid).toBe(true);
    expect(verification.payload.byteRangeStart).toBe(0);
    expect(verification.payload.byteRangeEnd).toBe(1023);
  });

  it('rejects an inverted byte range before ever issuing a token', async () => {
    const res = await GET(makeRequest({ range: '100-10' }));
    expect(res.status).toBe(400);
    expect(mockRecordDownloadAccess).not.toHaveBeenCalled();
  });

  it('returns 404 when the material has no file CID', async () => {
    mockGetDb.mockResolvedValue({
      collection: () => fakeMaterialsCollection({ materialId: MATERIAL_ID }),
    });

    const res = await GET(makeRequest());
    expect(res.status).toBe(404);
  });

  it('a token issued for one material cannot be replayed against another', async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    const capToken = new URL(body.fileUrl).searchParams.get('cap');

    const verification = verifyCapabilityToken(capToken, { buyerAddress: BUYER, materialId: 'a-different-material' });
    expect(verification.valid).toBe(false);
    expect(verification.reason).toBe('material_mismatch');
  });
});
