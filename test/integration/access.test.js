import { describe, it, expect, beforeEach } from 'vitest';
import { mockCollections, mockIndexer } from '../setup';
import { users, materials } from '../fixtures';

import { GET as GetAccess } from '../../src/app/api/materials/[id]/access/route.js';

describe('Buyer Access Status Flow', () => {
    beforeEach(() => {
        mockCollections.materials.findOne.mockClear();
        mockIndexer.getPurchaseStatus.mockClear();
    });

    it('returns 401 error shape for unauthorized wallet access', async () => {
        // Request without auth headers/cookies
        const req = new Request(`http://localhost/api/materials/${materials.published._id}/access`);
        const res = await GetAccess(req, { params: { id: materials.published._id } });
        const data = await res.json();

        expect(res.status).toBe(401);
        expect(data).toEqual({ error: 'Authentication required' });
    });

    it('returns not_purchased when no entitlement exists on-chain', async () => {
        mockCollections.materials.findOne.mockResolvedValue(materials.published);
        mockIndexer.getPurchaseStatus.mockResolvedValue('not_purchased');

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
        mockIndexer.getPurchaseStatus.mockResolvedValue('pending');

        const req = new Request(`http://localhost/api/materials/${materials.published._id}/access`, {
            headers: { 'x-user-wallet': users.buyer.walletAddress }
        });

        const res = await GetAccess(req, { params: { id: materials.published._id } });
        const data = await res.json();

        expect(data).toEqual({ status: 'pending', accessGranted: false });
    });

    it('returns available when purchase is confirmed on-chain', async () => {
        mockCollections.materials.findOne.mockResolvedValue(materials.published);
        mockIndexer.getPurchaseStatus.mockResolvedValue('available');

        const req = new Request(`http://localhost/api/materials/${materials.published._id}/access`, {
            headers: { 'x-user-wallet': users.buyer.walletAddress }
        });

        const res = await GetAccess(req, { params: { id: materials.published._id } });
        const data = await res.json();

        expect(data).toEqual({ status: 'available', accessGranted: true, downloadUrl: expect.any(String) });
    });
});
