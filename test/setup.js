import { vi } from 'vitest';

/**
 * EXTERNAL DEPENDENCY MOCKS DOCUMENTATION
 * 
 * 1. MongoDB (@/lib/mongodb): 
 *    Database connections are mocked to prevent actual I/O during integration tests. 
 *    We expose `mockCollections` so individual tests can configure `.mockResolvedValue()` 
 *    for specific DB states.
 * 
 * 2. Soroban Indexer (@/lib/indexer):
 *    The blockchain state is mocked via `mockIndexer`. We simulate the on-chain 
 *    entitlement status (not_purchased, pending, available) to verify the API's response 
 *    without running a local Soroban node.
 */

// --- 1. MongoDB Mock ---
export const mockCollections = {
    materials: {
        findOne: vi.fn(),
        insertOne: vi.fn(),
        updateOne: vi.fn(),
    },
    users: {
        findOne: vi.fn(),
    },
};

const mockDb = {
    collection: vi.fn((name) => mockCollections[name]),
};

vi.mock('@/lib/mongodb', () => ({
    getDb: vi.fn(() => mockDb),
}));

vi.mock('@/lib/api/auth', () => ({
    getUserFromCookie: vi.fn(async (request) => {
        const walletAddress = request?.headers?.get('x-user-wallet');
        if (!walletAddress) return null;
        return {
            sub: 'test_user_1',
            walletAddress,
            address: walletAddress,
        };
    }),
}));

// --- 2. Soroban Indexer Mock ---
export const mockIndexer = {
    getPurchaseStatus: vi.fn(),
};

vi.mock('@/lib/indexer', () => ({
    getPurchaseStatus: (...args) => mockIndexer.getPurchaseStatus(...args),
}));
