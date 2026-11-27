import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '../route';

const {
  mockGetUserFromCookie,
  mockCreateEntitlement,
  mockSendReceiptIfEligible,
  mockBroadcastPurchaseEvent,
  mockGetMaterialAccessStatus,
  mockGetDb,
  mockCreateCheckoutQuote,
  mockConsumeCheckoutQuote,
  mockValidateCheckoutQuote,
} = vi.hoisted(() => ({
  mockGetUserFromCookie: vi.fn(),
  mockCreateEntitlement: vi.fn(),
  mockSendReceiptIfEligible: vi.fn(),
  mockBroadcastPurchaseEvent: vi.fn(),
  mockGetMaterialAccessStatus: vi.fn(),
  mockGetDb: vi.fn(),
  mockCreateCheckoutQuote: vi.fn(),
  mockConsumeCheckoutQuote: vi.fn(),
  mockValidateCheckoutQuote: vi.fn(),
}));

vi.mock('@/lib/api/auth', () => ({ getUserFromCookie: mockGetUserFromCookie }));
vi.mock('@/lib/entitlement', () => ({ createEntitlement: mockCreateEntitlement }));
vi.mock('@/lib/email', () => ({ sendReceiptIfEligible: mockSendReceiptIfEligible }));
vi.mock('@/lib/webhooks/sender', () => ({ broadcastPurchaseEvent: mockBroadcastPurchaseEvent }));
vi.mock('@/lib/purchases/access', async () => {
  const actual = await vi.importActual('@/lib/purchases/access');
  return {
    ...actual,
    getMaterialAccessStatus: mockGetMaterialAccessStatus,
  };
});
vi.mock('@/lib/mongodb', () => ({ getDb: mockGetDb }));
vi.mock('@/lib/checkout/quotes', async () => {
  const actual = await vi.importActual('@/lib/checkout/quoteConstants');
  return {
    ...actual,
    createCheckoutQuote: mockCreateCheckoutQuote,
    consumeCheckoutQuote: mockConsumeCheckoutQuote,
    validateCheckoutQuote: mockValidateCheckoutQuote,
  };
});

// Fake collection that mimics a Mongo unique index on { buyerAddress, materialId }:
// insertOne throws a duplicate-key error (code 11000) if a matching doc already exists.
function createFakePurchases() {
  const docs = [];
  let nextId = 1;
  return {
    docs,
    async findOne(query) {
      await Promise.resolve();
      return docs.find((d) => d.buyerAddress === query.buyerAddress && d.materialId === query.materialId) || null;
    },
    async insertOne(doc) {
      await Promise.resolve();
      const clash = docs.find((d) => d.buyerAddress === doc.buyerAddress && d.materialId === doc.materialId);
      if (clash) {
        const err = new Error('E11000 duplicate key error');
        err.code = 11000;
        throw err;
      }
      const record = { ...doc, _id: `id-${nextId++}` };
      docs.push(record);
      return { insertedId: record._id };
    },
    async updateOne(query, update) {
      await Promise.resolve();
      const doc = docs.find((d) => d._id === query._id);
      if (doc) Object.assign(doc, update.$set);
      return { matchedCount: doc ? 1 : 0 };
    },
  };
}

function makeRequest(body) {
  return new Request('http://localhost:3000/api/purchase', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/purchase - concurrent duplicate requests', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetUserFromCookie.mockResolvedValue({ walletAddress: 'GBUYER123' });
    mockGetMaterialAccessStatus.mockResolvedValue({ hasAccess: true });
    mockCreateEntitlement.mockResolvedValue({ success: true });
    mockSendReceiptIfEligible.mockResolvedValue(undefined);
    mockConsumeCheckoutQuote.mockResolvedValue({ quoteId: 'quote-1', terms: { price: 10, asset: 'USDC' } });

    const purchases = createFakePurchases();
    mockGetDb.mockResolvedValue({
      collection: (name) => {
        if (name === 'purchases') return purchases;
        throw new Error(`Unexpected collection: ${name}`);
      },
    });
  });

  it('returns a stable problem-details code when materialId is missing', async () => {
    const res = await POST(makeRequest({}));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(body.code).toBe('VALIDATION_FIELD');
    expect(body.error).toBe('Missing materialId');
    expect(body.recovery).toBeTruthy();
  });

  it('returns a stable conflict code when a completed payment has no quote', async () => {
    const res = await POST(makeRequest({
      materialId: 'mat-1',
      transactionHash: 'txhash-1',
      amount: 10,
      asset: 'USDC',
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('CONFLICT_STATE');
    expect(body.error).toMatch(/valid checkout quote/i);
  });

  it('results in exactly one purchase document when two concurrent requests race', async () => {
    const body = {
      materialId: 'mat-1',
      buyerAddress: 'GBUYER123',
      transactionHash: 'txhash-1',
      quoteId: 'quote-1',
      amount: 10,
      asset: 'USDC',
    };

    const [res1, res2] = await Promise.all([
      POST(makeRequest(body)),
      POST(makeRequest(body)),
    ]);

    expect([res1.status, res2.status].sort()).toEqual([200, 201]);

    const db = await mockGetDb();
    const allDocs = db.collection('purchases').docs;
    expect(allDocs).toHaveLength(1);

    // Receipt + webhook must fire exactly once per actual purchase, not once per request.
    expect(mockSendReceiptIfEligible).toHaveBeenCalledTimes(1);
    expect(mockBroadcastPurchaseEvent).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/purchase - pre-signing stale quote validation (action: validate_quote)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserFromCookie.mockResolvedValue({ walletAddress: 'GBUYER123' });
    mockGetDb.mockResolvedValue({
      collection: () => {
        throw new Error('Unexpected direct collection access');
      },
    });
  });

  it('returns 200 fresh payload on the normal path', async () => {
    const expiresAt = new Date('2030-01-01T00:10:00.000Z');
    const checkedAt = new Date('2030-01-01T00:00:00.000Z');
    mockValidateCheckoutQuote.mockResolvedValue({
      fresh: true,
      stale: false,
      authorized: true,
      quote: {
        quoteId: 'quote-fresh',
        materialId: 'mat-1',
        buyerAddress: 'gbuyer123',
        terms: { price: 10, asset: 'USDC', creatorAddress: 'gcreator', materialVersion: 1 },
      },
      expiresAt,
      remainingMs: 600_000,
      checkedAt,
    });

    const res = await POST(makeRequest({
      action: 'validate_quote',
      materialId: 'mat-1',
      quoteId: 'quote-fresh',
      minRemainingMs: 15_000,
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.fresh).toBe(true);
    expect(body.stale).toBe(false);
    expect(body.quoteId).toBe('quote-fresh');
    expect(body.price).toBe(10);
    expect(mockValidateCheckoutQuote).toHaveBeenCalledWith(expect.anything(), {
      quoteId: 'quote-fresh',
      materialId: 'mat-1',
      buyerAddress: 'gbuyer123',
      minRemainingMs: 15_000,
    });
  });

  it('returns 400 VALIDATION_FIELD when quoteId is missing', async () => {
    const res = await POST(makeRequest({
      action: 'validate_quote',
      materialId: 'mat-1',
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('VALIDATION_FIELD');
    expect(body.error).toMatch(/Missing quoteId/i);
  });

  it('returns 410 SETTLEMENT_QUOTE_EXPIRED when quote is expired before signing', async () => {
    mockValidateCheckoutQuote.mockResolvedValue({
      fresh: false,
      stale: true,
      authorized: true,
      canRefresh: true,
      reason: 'QUOTE_EXPIRED',
      expiresAt: new Date('2025-01-01T00:00:00.000Z'),
      checkedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const res = await POST(makeRequest({
      action: 'validate_quote',
      materialId: 'mat-1',
      quoteId: 'quote-expired',
    }));
    const body = await res.json();

    expect(res.status).toBe(410);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(body.code).toBe('SETTLEMENT_QUOTE_EXPIRED');
    expect(body.stale).toBe(true);
    expect(body.reason).toBe('QUOTE_EXPIRED');
    expect(body.canRefresh).toBe(true);
  });

  it('returns 409 CONFLICT_STATE with changedFields when listing terms drifted', async () => {
    mockValidateCheckoutQuote.mockResolvedValue({
      fresh: false,
      stale: true,
      authorized: true,
      canRefresh: true,
      reason: 'TERMS_CHANGED',
      changedFields: ['price'],
      quoteTerms: { price: 10, asset: 'USDC', creatorAddress: 'gcreator', materialVersion: 1 },
      currentTerms: { price: 15, asset: 'USDC', creatorAddress: 'gcreator', materialVersion: 1 },
      checkedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const res = await POST(makeRequest({
      action: 'validate_quote',
      materialId: 'mat-1',
      quoteId: 'quote-drifted',
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('CONFLICT_STATE');
    expect(body.stale).toBe(true);
    expect(body.reason).toBe('TERMS_CHANGED');
    expect(body.changedFields).toEqual(['price']);
    expect(body.currentTerms.price).toBe(15);
    expect(body.canRefresh).toBe(true);
  });

  it('returns 403 AUTH_WALLET_MISMATCH when body buyerAddress differs from session wallet', async () => {
    const res = await POST(makeRequest({
      action: 'validate_quote',
      materialId: 'mat-1',
      quoteId: 'quote-1',
      buyerAddress: 'GDIFFERENTWALLET',
    }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe('AUTH_WALLET_MISMATCH');
    expect(mockValidateCheckoutQuote).not.toHaveBeenCalled();
  });

  it('returns 401 AUTH_UNAUTHENTICATED when neither session nor buyerAddress is present', async () => {
    mockGetUserFromCookie.mockResolvedValue(null);

    const res = await POST(makeRequest({
      action: 'validate_quote',
      materialId: 'mat-1',
      quoteId: 'quote-1',
    }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.code).toBe('AUTH_UNAUTHENTICATED');
  });

  it('supports retry after stale detection by issuing a fresh quote and validating it', async () => {
    const expiresAt = new Date('2030-01-01T00:10:00.000Z');
    mockCreateCheckoutQuote.mockResolvedValue({
      quoteId: 'quote-2',
      materialId: 'mat-1',
      buyerAddress: 'gbuyer123',
      terms: { price: 15, asset: 'USDC', creatorAddress: 'gcreator', materialVersion: 2 },
      expiresAt,
    });
    mockValidateCheckoutQuote.mockResolvedValue({
      fresh: true,
      stale: false,
      authorized: true,
      quote: {
        quoteId: 'quote-2',
        materialId: 'mat-1',
        buyerAddress: 'gbuyer123',
        terms: { price: 15, asset: 'USDC', creatorAddress: 'gcreator', materialVersion: 2 },
      },
      expiresAt,
      remainingMs: 599_000,
      checkedAt: new Date('2030-01-01T00:00:01.000Z'),
    });

    const quoteRes = await POST(makeRequest({ action: 'quote', materialId: 'mat-1' }));
    const quoteBody = await quoteRes.json();
    expect(quoteRes.status).toBe(201);
    expect(quoteBody.quoteId).toBe('quote-2');

    const validateRes = await POST(makeRequest({
      action: 'validate_quote',
      materialId: 'mat-1',
      quoteId: quoteBody.quoteId,
    }));
    const validateBody = await validateRes.json();
    expect(validateRes.status).toBe(200);
    expect(validateBody.fresh).toBe(true);
    expect(validateBody.price).toBe(15);
  });
});
