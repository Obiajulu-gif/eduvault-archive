import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '../route';

const {
  mockGetUserFromCookie,
  mockCreateEntitlement,
  mockSendReceiptIfEligible,
  mockBroadcastPurchaseEvent,
  mockGetMaterialAccessStatus,
  mockGetDb,
  mockConsumeCheckoutQuote,
} = vi.hoisted(() => ({
  mockGetUserFromCookie: vi.fn(),
  mockCreateEntitlement: vi.fn(),
  mockSendReceiptIfEligible: vi.fn(),
  mockBroadcastPurchaseEvent: vi.fn(),
  mockGetMaterialAccessStatus: vi.fn(),
  mockGetDb: vi.fn(),
  mockConsumeCheckoutQuote: vi.fn(),
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
vi.mock('@/lib/checkout/quotes', () => ({
  createCheckoutQuote: vi.fn(),
  consumeCheckoutQuote: mockConsumeCheckoutQuote,
}));

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
