import { vi } from 'vitest';

/**
 * EXTERNAL DEPENDENCY MOCKS DOCUMENTATION
 *
 * 1. MongoDB (@/lib/mongodb):
 *    Database connections are mocked to prevent actual I/O during integration tests.
 *    We expose `mockCollections` so individual tests can configure `.mockResolvedValue()`
 *    for specific DB states. `materials`, `purchases`, `entitlement_cache`, and `users`
 *    back the unified entitlement policy boundary (src/lib/entitlement.js) — every
 *    protected download/access route resolves through it, so these four collections
 *    are what tests configure to drive finalized/provisional/revoked/unavailable
 *    outcomes.
 */

// --- MongoDB Mock ---
function makeCollectionMock() {
    return {
        findOne: vi.fn().mockResolvedValue(null),
        insertOne: vi.fn(),
        updateOne: vi.fn().mockResolvedValue({ matchedCount: 0, upsertedCount: 0 }),
    };
}

export const mockCollections = {
    materials: makeCollectionMock(),
    users: makeCollectionMock(),
    purchases: makeCollectionMock(),
    entitlement_cache: makeCollectionMock(),
};

const mockDb = {
    collection: vi.fn((name) => mockCollections[name]),
};

vi.mock('@/lib/mongodb', () => ({
    getDb: vi.fn(() => mockDb),
}));

vi.mock('@/lib/api/auth', () => ({
    getUserFromCookie: vi.fn(async () => ({
        sub: 'test_user_1',
        walletAddress: '0xCreatorWalletAddress1234567890',
        address: '0xCreatorWalletAddress1234567890',
    })),
}));
