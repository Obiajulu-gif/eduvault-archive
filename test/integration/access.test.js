import { describe, it, expect, beforeEach } from 'vitest';
import { mockCollections } from '../setup';
import { users, materials } from '../fixtures';

import { GET as GetAccess } from '../../src/app/api/materials/[id]/access/route.js';

describe('Buyer Access Status Flow', () => {
    beforeEach(() => {
        mockCollections.materials.findOne.mockReset().mockResolvedValue(null);
        mockCollections.purchases.findOne.mockReset().mockResolvedValue(null);
        mockCollections.entitlement_cache.findOne.mockReset().mockResolvedValue(null);
        mockCollections.entitlement_cache.updateOne.mockReset().mockResolvedValue({ matchedCount: 0, upsertedCount: 1 });
        mockCollections.users.findOne.mockReset().mockResolvedValue(null);
    });

    it('returns 401 error shape for unauthorized wallet access', async () => {
        // Request without auth headers/cookies
        const req = new Request(`http://localhost/api/materials/${materials.published._id}/access`);
        const res = await GetAccess(req, { params: { id: materials.published._id } });
        const data = await res.json();

        expect(res.status).toBe(401);
        expect(data).toEqual({ error: 'Unauthorized: Wallet connection required' });
    });

    it('returns not_purchased when no entitlement exists on-chain', async () => {
        mockCollections.materials.findOne.mockResolvedValue(materials.published);
        mockCollections.purchases.findOne.mockResolvedValue(null);

        const req = new Request(`http://localhost/api/materials/${materials.published._id}/access`, {
            headers: { 'x-user-wallet': users.buyer.walletAddress } // Mocking auth header for test
        });

        const res = await GetAccess(req, { params: { id: materials.published._id } });
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data).toEqual({ status: 'not_purchased', accessGranted: false });
    });

    it('returns pending when purchase transaction is indexing', async () => {
        mockCollections.materials.findOne.mockResolvedValue(materials.published);
        mockCollections.purchases.findOne.mockResolvedValue({
            materialId: materials.published._id,
            buyerAddress: users.buyer.walletAddress.toLowerCase(),
            status: 'pending',
        });

        const req = new Request(`http://localhost/api/materials/${materials.published._id}/access`, {
            headers: { 'x-user-wallet': users.buyer.walletAddress }
        });

        const res = await GetAccess(req, { params: { id: materials.published._id } });
        const data = await res.json();

        expect(data).toEqual({ status: 'pending', accessGranted: false });
    });

    it('returns available when purchase is confirmed on-chain', async () => {
        mockCollections.materials.findOne.mockResolvedValue(materials.published);
        mockCollections.purchases.findOne.mockResolvedValue({
            materialId: materials.published._id,
            buyerAddress: users.buyer.walletAddress.toLowerCase(),
            status: 'settled',
        });

        const req = new Request(`http://localhost/api/materials/${materials.published._id}/access`, {
            headers: { 'x-user-wallet': users.buyer.walletAddress }
        });

        const res = await GetAccess(req, { params: { id: materials.published._id } });
        const data = await res.json();

        expect(data).toEqual({ status: 'available', accessGranted: true, downloadUrl: expect.any(String) });
    });

    it('denies access when the purchase has been refunded, even though the cache says active', async () => {
        mockCollections.materials.findOne.mockResolvedValue(materials.published);
        // Stale/attacker-favorable cache entry claiming an active entitlement.
        mockCollections.entitlement_cache.findOne.mockResolvedValue({
            materialId: materials.published._id,
            buyerAddress: users.buyer.walletAddress.toLowerCase(),
            state: 'finalized',
            active: true,
            checkedAt: new Date(),
        });
        // Source-of-truth purchase record shows the purchase was refunded.
        mockCollections.purchases.findOne.mockResolvedValue({
            materialId: materials.published._id,
            buyerAddress: users.buyer.walletAddress.toLowerCase(),
            status: 'settled',
            settlementState: 'Refunded',
        });

        const req = new Request(`http://localhost/api/materials/${materials.published._id}/access`, {
            headers: { 'x-user-wallet': users.buyer.walletAddress }
        });

        const res = await GetAccess(req, { params: { id: materials.published._id } });
        const data = await res.json();

        expect(data.accessGranted).toBe(false);
    });

    it('denies access for a suspended buyer even with a completed purchase', async () => {
        mockCollections.materials.findOne.mockResolvedValue(materials.published);
        mockCollections.purchases.findOne.mockResolvedValue({
            materialId: materials.published._id,
            buyerAddress: users.buyer.walletAddress.toLowerCase(),
            status: 'settled',
        });
        mockCollections.users.findOne.mockResolvedValue({ status: 'suspended' });

        const req = new Request(`http://localhost/api/materials/${materials.published._id}/access`, {
            headers: { 'x-user-wallet': users.buyer.walletAddress }
        });

        const res = await GetAccess(req, { params: { id: materials.published._id } });
        const data = await res.json();

        expect(data).toEqual({ status: 'suspended', accessGranted: false });
    });
});
