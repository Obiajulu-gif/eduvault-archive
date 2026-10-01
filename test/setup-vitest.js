import { vi } from 'vitest';
import { mockCollections } from './setup';

// Mock external dependencies for purchase flow E2E tests

// Mock Stellar Horizon client for trustline checks
vi.mock('@/lib/stellar/horizonClient', () => ({
    checkBuyerTrustline: vi.fn(() => ({
        hasTrustline: true,
        instructions: { message: 'Trustline active' },
    })),
}));

// Mock tax estimator
vi.mock('@/lib/checkout/taxEstimator', () => ({
    applyTaxToCheckout: vi.fn(async ({ amount }) => ({
        totalAmount: amount,
        taxAmount: 0,
        taxRateBps: 0,
        geolocation: { country: 'US', region: 'CA' },
    })),
}));

// Mock discount verifier
vi.mock('@/lib/checkout/discountVerifier', () => ({
    verifyDiscount: vi.fn(async () => ({
        valid: false,
        discount: null,
        discountAmountPercent: 0,
    })),
    findMaterial: vi.fn(async (materialId) => {
        // Return mock material
        const materials = await import('./fixtures/index.js');
        return materials.purchaseFixtures?.material || null;
    }),
}));

// Mock checkout intent store
vi.mock('@/lib/checkout/checkoutIntentStore', () => ({
    CHECKOUT_INTENT_EXPIRY: 10 * 60 * 1000,
    ensureCheckoutIntentIndexes: vi.fn(async () => {}),
    findIntentByIdempotencyKey: vi.fn(async () => null),
    insertCheckoutIntent: vi.fn(async (db, intent) => ({
        intent: { ...intent, _id: 'intent_001' },
        duplicate: false,
    })),
}));

// Mock entitlement creation
vi.mock('@/lib/entitlement', () => ({
    createEntitlement: vi.fn(async () => ({ success: true })),
}));

// Mock email service
vi.mock('@/lib/email', () => ({
    sendReceiptIfEligible: vi.fn(async () => {}),
}));

// Mock webhook sender
vi.mock('@/lib/webhooks/sender', () => ({
    broadcastPurchaseEvent: vi.fn(async () => {}),
}));

// Mock analytics events
vi.mock('@/lib/backend/analyticsEvents', () => ({
    buildAnalyticsEvent: vi.fn(() => ({ eventType: 'purchase' })),
    recordServerAnalyticsEvent: vi.fn(async () => {}),
}));

// Mock audit ledger
vi.mock('@/lib/backend/auditLedger', () => ({
    appendCriticalMutation: vi.fn(async () => {}),
}));

// Mock access status
vi.mock('@/lib/purchases/access', () => ({
    getMaterialAccessStatus: vi.fn(async (db, materialId, buyerAddress) => {
        const cached = await mockCollections.entitlement_cache.findOne({
            materialId,
            buyerAddress: buyerAddress.toLowerCase(),
        });
        return {
            status: cached?.active ? 'available' : 'not_purchased',
            accessGranted: !!cached?.active,
            source: cached?.source || 'unknown',
        };
    }),
    isCompletedPurchaseStatus: vi.fn((status) =>
        ['confirmed', 'settled', 'completed'].includes(status)
    ),
    normalizeBuyerAddress: vi.fn((address) =>
        address ? String(address).toLowerCase() : address
    ),
}));

// Mock MongoDB collections for find operation
mockCollections.purchases.find = vi.fn(() => ({
    sort: vi.fn(() => ({
        toArray: vi.fn(() => Promise.resolve([])),
    })),
}));
