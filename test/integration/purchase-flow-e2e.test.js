/**
 * End-to-End Test Suite for Purchase Flow (Issue #787)
 *
 * This suite covers the highest-risk user journey: the complete purchase/checkout flow.
 * Tests include:
 * - Happy path: successful purchase from quote to entitlement
 * - Validation failures: invalid inputs, missing fields
 * - Payment failures: payment processing errors, expired quotes
 * - Duplicate purchase prevention: idempotency and race conditions
 * - Retry and recovery: idempotency keys and interrupted checkouts
 *
 * External dependencies are mocked to ensure deterministic, isolated tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockCollections } from '../setup';
import { users, materials, purchaseFixtures } from '../fixtures';

import { POST as InitiateCheckout } from '../../src/app/api/checkout/initiate/route.js';
import { POST as CreatePurchase } from '../../src/app/api/purchase/route.js';
import { GET as GetPurchase } from '../../src/app/api/purchase/route.js';

describe('Purchase Flow E2E - Highest Risk User Journey', () => {
    beforeEach(() => {
        // Reset all mocks before each test
        mockCollections.materials.findOne.mockReset().mockResolvedValue(null);
        mockCollections.materials.insertOne.mockReset();
        mockCollections.checkout_quotes.findOne.mockReset().mockResolvedValue(null);
        mockCollections.checkout_quotes.insertOne.mockReset();
        mockCollections.checkout_quotes.findOneAndUpdate.mockReset();
        mockCollections.purchases.findOne.mockReset().mockResolvedValue(null);
        mockCollections.purchases.insertOne.mockReset();
        mockCollections.purchases.updateOne.mockReset();
        mockCollections.entitlement_cache.findOne.mockReset().mockResolvedValue(null);
        mockCollections.entitlement_cache.updateOne.mockReset();
        mockCollections.users.findOne.mockReset().mockResolvedValue(null);
        mockCollections.checkout_intents.findOne.mockReset().mockResolvedValue(null);
        mockCollections.checkout_intents.insertOne.mockReset();
    });

    // =============================================================================
    // HAPPY PATH: Successful Purchase Flow
    // =============================================================================

    describe('Happy Path - Successful Purchase', () => {
        it('completes full purchase flow: initiate checkout -> quote -> payment -> entitlement', async () => {
            // Step 1: Material exists and is available
            mockCollections.materials.findOne.mockResolvedValue(purchaseFixtures.material);

            // Step 2: User initiates checkout
            const checkoutReq = new Request('http://localhost/api/checkout/initiate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    materialId: purchaseFixtures.material._id,
                    amount: '25',
                    asset: 'USDC',
                    buyerIp: '192.168.1.1',
                    buyerCountry: 'US',
                }),
            });

            const checkoutRes = await InitiateCheckout(checkoutReq);
            const checkoutData = await checkoutRes.json();

            expect(checkoutRes.status).toBe(201);
            expect(checkoutData.success).toBe(true);
            expect(checkoutData.checkoutId).toBeDefined();
            expect(checkoutData.checkout.totalAmount).toBeDefined();

            // Step 3: Checkout quote is created
            const quoteId = checkoutData.checkoutId;
            mockCollections.checkout_quotes.findOne.mockResolvedValue({
                ...purchaseFixtures.checkoutQuote,
                quoteId,
            });

            // Step 4: User completes payment
            const purchaseReq = new Request('http://localhost/api/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    materialId: purchaseFixtures.material._id,
                    quoteId,
                    transactionHash: purchaseFixtures.stellarTransaction.hash,
                    signedXdr: purchaseFixtures.stellarTransaction.xdr,
                    amount: '25',
                    asset: 'USDC',
                    email: users.buyer.email,
                }),
            });

            // Mock quote consumption
            mockCollections.checkout_quotes.findOneAndUpdate.mockResolvedValue({
                value: { ...purchaseFixtures.checkoutQuote, quoteId },
            });

            // Mock purchase insertion
            const mockPurchaseId = 'purchase_test_001';
            mockCollections.purchases.insertOne.mockResolvedValue({ insertedId: mockPurchaseId });
            mockCollections.purchases.findOne.mockResolvedValue({
                ...purchaseFixtures.purchase,
                _id: mockPurchaseId,
            });

            // Mock entitlement creation
            mockCollections.entitlement_cache.updateOne.mockResolvedValue({
                matchedCount: 1,
                upsertedCount: 0,
            });

            const purchaseRes = await CreatePurchase(purchaseReq);
            const purchaseData = await purchaseRes.json();

            expect(purchaseRes.status).toBe(201);
            expect(purchaseData.success).toBe(true);
            expect(purchaseData.purchaseId).toBeDefined();
            expect(purchaseData.purchase.status).toBe('confirmed');
            expect(purchaseData.access).toBeDefined();

            // Verify purchase was inserted
            expect(mockCollections.purchases.insertOne).toHaveBeenCalledWith(
                expect.objectContaining({
                    materialId: purchaseFixtures.material._id,
                    buyerAddress: users.buyer.walletAddress.toLowerCase(),
                    status: 'confirmed',
                    amount: '25',
                    asset: 'USDC',
                })
            );

            // Verify entitlement was created
            expect(mockCollections.entitlement_cache.updateOne).toHaveBeenCalledWith(
                expect.objectContaining({
                    materialId: purchaseFixtures.material._id,
                    buyerAddress: users.buyer.walletAddress.toLowerCase(),
                }),
                expect.objectContaining({
                    $set: expect.objectContaining({
                        active: true,
                        source: 'purchase-api',
                    }),
                }),
                expect.objectContaining({ upsert: true })
            );
        });

        it('allows buyer to retrieve purchase history after successful purchase', async () => {
            // Mock existing purchases
            mockCollections.purchases.find.mockReturnValue({
                sort: vi.fn().mockReturnValue({
                    toArray: vi.fn().mockResolvedValue([
                        {
                            ...purchaseFixtures.purchase,
                            _id: 'purchase_001',
                        },
                    ]),
                }),
            });

            const req = new Request('http://localhost/api/purchase');
            const res = await GetPurchase(req);
            const data = await res.json();

            expect(res.status).toBe(200);
            expect(Array.isArray(data)).toBe(true);
            expect(data.length).toBeGreaterThan(0);
            expect(data[0].materialId).toBe(purchaseFixtures.material._id);
        });
    });

    // =============================================================================
    // VALIDATION FAILURES
    // =============================================================================

    describe('Validation Failures', () => {
        it('rejects checkout initiation with missing materialId', async () => {
            const req = new Request('http://localhost/api/checkout/initiate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    amount: '25',
                    asset: 'USDC',
                }),
            });

            const res = await InitiateCheckout(req);
            const data = await res.json();

            expect(res.status).toBe(400);
            expect(data.error).toBe('Missing materialId');
        });

        it('rejects checkout initiation with invalid amount', async () => {
            const req = new Request('http://localhost/api/checkout/initiate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    materialId: purchaseFixtures.material._id,
                    amount: '-10',
                    asset: 'USDC',
                }),
            });

            const res = await InitiateCheckout(req);
            const data = await res.json();

            expect(res.status).toBe(400);
            expect(data.error).toBe('Invalid amount');
        });

        it('rejects checkout initiation with missing asset', async () => {
            const req = new Request('http://localhost/api/checkout/initiate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    materialId: purchaseFixtures.material._id,
                    amount: '25',
                }),
            });

            const res = await InitiateCheckout(req);
            const data = await res.json();

            expect(res.status).toBe(400);
            expect(data.error).toBe('Missing asset');
        });

        it('rejects purchase creation with missing materialId', async () => {
            const req = new Request('http://localhost/api/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transactionHash: '0x123',
                    amount: '25',
                }),
            });

            const res = await CreatePurchase(req);
            const data = await res.json();

            expect(res.status).toBe(400);
            expect(data.error).toBe('Missing materialId');
        });

        it('rejects purchase creation with missing buyer address', async () => {
            // Mock auth returning null user
            vi.doMock('@/lib/api/auth', () => ({
                getUserFromCookie: vi.fn(async () => null),
            }));

            const req = new Request('http://localhost/api/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    materialId: purchaseFixtures.material._id,
                    transactionHash: '0x123',
                }),
            });

            const res = await CreatePurchase(req);
            const data = await res.json();

            expect(res.status).toBe(401);
            expect(data.error).toBe('Unauthorized');
        });
    });

    // =============================================================================
    // PAYMENT FAILURES
    // =============================================================================

    describe('Payment Failures', () => {
        it('rejects purchase with expired checkout quote', async () => {
            mockCollections.materials.findOne.mockResolvedValue(purchaseFixtures.material);
            mockCollections.checkout_quotes.findOne.mockResolvedValue(null);
            mockCollections.checkout_quotes.findOneAndUpdate.mockResolvedValue(null);

            // Mock expired quote in DB
            mockCollections.checkout_quotes.findOne.mockResolvedValue({
                ...purchaseFixtures.checkoutQuote,
                expiresAt: new Date(Date.now() - 1000), // Expired
            });

            const req = new Request('http://localhost/api/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    materialId: purchaseFixtures.material._id,
                    quoteId: 'expired-quote-id',
                    transactionHash: '0x123',
                    amount: '25',
                    asset: 'USDC',
                }),
            });

            const res = await CreatePurchase(req);
            const data = await res.json();

            expect(res.status).toBe(409);
            expect(data.error).toContain('expired');
        });

        it('rejects purchase with invalid checkout quote', async () => {
            mockCollections.materials.findOne.mockResolvedValue(purchaseFixtures.material);
            mockCollections.checkout_quotes.findOne.mockResolvedValue(null);
            mockCollections.checkout_quotes.findOneAndUpdate.mockResolvedValue(null);

            const req = new Request('http://localhost/api/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    materialId: purchaseFixtures.material._id,
                    quoteId: 'invalid-quote-id',
                    transactionHash: '0x123',
                    amount: '25',
                    asset: 'USDC',
                }),
            });

            const res = await CreatePurchase(req);
            const data = await res.json();

            expect(res.status).toBe(409);
            expect(data.error).toContain('invalid');
        });

        it('rejects purchase without quote when payment is completed', async () => {
            mockCollections.materials.findOne.mockResolvedValue(purchaseFixtures.material);
            mockCollections.purchases.findOne.mockResolvedValue(null);

            const req = new Request('http://localhost/api/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    materialId: purchaseFixtures.material._id,
                    transactionHash: '0x123',
                    amount: '25',
                    asset: 'USDC',
                }),
            });

            const res = await CreatePurchase(req);
            const data = await res.json();

            expect(res.status).toBe(409);
            expect(data.error).toContain('checkout quote is required');
        });

        it('handles material not available for checkout', async () => {
            // Material is deleted or archived
            mockCollections.materials.findOne.mockResolvedValue({
                ...purchaseFixtures.material,
                isDeleted: true,
            });

            const req = new Request('http://localhost/api/checkout/initiate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    materialId: purchaseFixtures.material._id,
                    amount: '25',
                    asset: 'USDC',
                }),
            });

            const res = await InitiateCheckout(req);
            const data = await res.json();

            expect(res.status).toBe(500);
            expect(data.error).toBe('Server error');
        });
    });

    // =============================================================================
    // DUPLICATE PURCHASE PREVENTION
    // =============================================================================

    describe('Duplicate Purchase Prevention', () => {
        it('prevents duplicate purchase for same material and buyer', async () => {
            mockCollections.materials.findOne.mockResolvedValue(purchaseFixtures.material);
            mockCollections.checkout_quotes.findOneAndUpdate.mockResolvedValue({
                value: purchaseFixtures.checkoutQuote,
            });

            // Existing purchase already exists
            mockCollections.purchases.findOne.mockResolvedValue({
                ...purchaseFixtures.purchase,
                status: 'confirmed',
            });

            const req = new Request('http://localhost/api/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    materialId: purchaseFixtures.material._id,
                    quoteId: purchaseFixtures.checkoutQuote.quoteId,
                    transactionHash: '0xNewTransaction',
                    amount: '25',
                    asset: 'USDC',
                }),
            });

            const res = await CreatePurchase(req);
            const data = await res.json();

            expect(res.status).toBe(200);
            expect(data.message).toBe('Already purchased');
            expect(data.purchase).toBeDefined();
            expect(data.access).toBeDefined();

            // Verify no new purchase was inserted
            expect(mockCollections.purchases.insertOne).not.toHaveBeenCalled();
        });

        it('handles concurrent purchase attempts with race condition', async () => {
            mockCollections.materials.findOne.mockResolvedValue(purchaseFixtures.material);
            mockCollections.checkout_quotes.findOneAndUpdate.mockResolvedValue({
                value: purchaseFixtures.checkoutQuote,
            });

            // First call: no existing purchase
            mockCollections.purchases.findOne.mockResolvedValueOnce(null);

            // Insert fails with duplicate key error (race condition)
            const duplicateError = new Error('duplicate key');
            duplicateError.code = 11000;
            mockCollections.purchases.insertOne.mockRejectedValueOnce(duplicateError);

            // Second call: find the winning purchase
            mockCollections.purchases.findOne.mockResolvedValueOnce({
                ...purchaseFixtures.purchase,
                status: 'confirmed',
            });

            const req = new Request('http://localhost/api/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    materialId: purchaseFixtures.material._id,
                    quoteId: purchaseFixtures.checkoutQuote.quoteId,
                    transactionHash: '0xRaceCondition',
                    amount: '25',
                    asset: 'USDC',
                }),
            });

            const res = await CreatePurchase(req);
            const data = await res.json();

            expect(res.status).toBe(200);
            expect(data.message).toBe('Already purchased');
            expect(data.purchase).toBeDefined();
        });

        it('returns pending status for incomplete purchase', async () => {
            mockCollections.materials.findOne.mockResolvedValue(purchaseFixtures.material);
            mockCollections.purchases.findOne.mockResolvedValue({
                ...purchaseFixtures.purchase,
                status: 'pending',
            });

            const req = new Request('http://localhost/api/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    materialId: purchaseFixtures.material._id,
                    action: 'quote',
                }),
            });

            const res = await CreatePurchase(req);
            const data = await res.json();

            expect(res.status).toBe(202);
            expect(data.message).toBe('Payment pending');
        });
    });

    // =============================================================================
    // RETRY AND RECOVERY (IDEMPOTENCY)
    // =============================================================================

    describe('Retry and Recovery - Idempotency', () => {
        it('honors idempotency key for checkout initiation', async () => {
            mockCollections.materials.findOne.mockResolvedValue(purchaseFixtures.material);
            mockCollections.checkout_intents.findOne.mockResolvedValue({
                ...purchaseFixtures.checkoutQuote,
                idempotencyKey: 'test-idempotency-key-123',
            });

            const req = new Request('http://localhost/api/checkout/initiate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-idempotency-key': 'test-idempotency-key-123',
                },
                body: JSON.stringify({
                    materialId: purchaseFixtures.material._id,
                    amount: '25',
                    asset: 'USDC',
                }),
            });

            const res = await InitiateCheckout(req);
            const data = await res.json();

            expect(res.status).toBe(200);
            expect(data.success).toBe(true);
            expect(data.duplicate).toBe(true);
            expect(data.checkoutId).toBeDefined();

            // Verify no new intent was inserted
            expect(mockCollections.checkout_intents.insertOne).not.toHaveBeenCalled();
        });

        it('creates new checkout when idempotency key is not provided', async () => {
            mockCollections.materials.findOne.mockResolvedValue(purchaseFixtures.material);
            mockCollections.checkout_intents.findOne.mockResolvedValue(null);
            mockCollections.checkout_intents.insertOne.mockResolvedValue({
                insertedId: 'intent_001',
                intent: { ...purchaseFixtures.checkoutQuote, _id: 'intent_001' },
                duplicate: false,
            });

            const req = new Request('http://localhost/api/checkout/initiate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    materialId: purchaseFixtures.material._id,
                    amount: '25',
                    asset: 'USDC',
                }),
            });

            const res = await InitiateCheckout(req);
            const data = await res.json();

            expect(res.status).toBe(201);
            expect(data.success).toBe(true);
            expect(data.duplicate).toBe(false);
        });

        it('handles interrupted checkout with pending state', async () => {
            mockCollections.materials.findOne.mockResolvedValue(purchaseFixtures.material);
            mockCollections.purchases.findOne.mockResolvedValue({
                ...purchaseFixtures.purchase,
                status: 'pending',
                transactionHash: null,
            });

            const req = new Request('http://localhost/api/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    materialId: purchaseFixtures.material._id,
                    paymentCompleted: false,
                }),
            });

            const res = await CreatePurchase(req);
            const data = await res.json();

            expect(res.status).toBe(202);
            expect(data.message).toBe('Payment pending');
        });

        it('updates pending purchase to confirmed on payment completion', async () => {
            mockCollections.materials.findOne.mockResolvedValue(purchaseFixtures.material);
            mockCollections.checkout_quotes.findOneAndUpdate.mockResolvedValue({
                value: purchaseFixtures.checkoutQuote,
            });

            // Existing pending purchase
            const existingPurchase = {
                ...purchaseFixtures.purchase,
                status: 'pending',
                transactionHash: null,
                _id: 'purchase_pending_001',
            };
            mockCollections.purchases.findOne.mockResolvedValueOnce(existingPurchase);

            // Mock update
            mockCollections.purchases.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
            mockCollections.purchases.findOne.mockResolvedValueOnce({
                ...existingPurchase,
                status: 'confirmed',
                transactionHash: '0xCompletedTransaction',
            });

            const req = new Request('http://localhost/api/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    materialId: purchaseFixtures.material._id,
                    quoteId: purchaseFixtures.checkoutQuote.quoteId,
                    transactionHash: '0xCompletedTransaction',
                    amount: '25',
                    asset: 'USDC',
                    paymentCompleted: true,
                }),
            });

            const res = await CreatePurchase(req);
            const data = await res.json();

            expect(res.status).toBe(200);
            expect(data.success).toBe(true);
            expect(data.purchase.status).toBe('confirmed');

            // Verify update was called
            expect(mockCollections.purchases.updateOne).toHaveBeenCalledWith(
                { _id: existingPurchase._id },
                expect.objectContaining({
                    $set: expect.objectContaining({
                        status: 'confirmed',
                        transactionHash: '0xCompletedTransaction',
                    }),
                })
            );
        });
    });

    // =============================================================================
    // ACCESS CONTROL AFTER PURCHASE
    // =============================================================================

    describe('Access Control After Purchase', () => {
        it('grants access immediately after successful purchase', async () => {
            mockCollections.materials.findOne.mockResolvedValue(purchaseFixtures.material);
            mockCollections.checkout_quotes.findOneAndUpdate.mockResolvedValue({
                value: purchaseFixtures.checkoutQuote,
            });

            const mockPurchaseId = 'purchase_access_001';
            mockCollections.purchases.insertOne.mockResolvedValue({ insertedId: mockPurchaseId });
            mockCollections.purchases.findOne.mockResolvedValue({
                ...purchaseFixtures.purchase,
                _id: mockPurchaseId,
            });

            // Mock access status check
            mockCollections.entitlement_cache.findOne.mockResolvedValue(purchaseFixtures.entitlement);

            const req = new Request('http://localhost/api/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    materialId: purchaseFixtures.material._id,
                    quoteId: purchaseFixtures.checkoutQuote.quoteId,
                    transactionHash: '0xAccessTest',
                    amount: '25',
                    asset: 'USDC',
                }),
            });

            const res = await CreatePurchase(req);
            const data = await res.json();

            expect(res.status).toBe(201);
            expect(data.access).toBeDefined();
            expect(data.access.accessGranted).toBe(true);
        });

        it('denies access for non-purchaser', async () => {
            mockCollections.materials.findOne.mockResolvedValue(purchaseFixtures.material);
            mockCollections.purchases.findOne.mockResolvedValue(null);
            mockCollections.entitlement_cache.findOne.mockResolvedValue(null);

            const req = new Request('http://localhost/api/purchase', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    materialId: purchaseFixtures.material._id,
                    action: 'quote',
                }),
            });

            const res = await CreatePurchase(req);
            const data = await res.json();

            expect(res.status).toBe(202);
            expect(data.access).toBeDefined();
            expect(data.access.accessGranted).toBe(false);
        });
    });
});
