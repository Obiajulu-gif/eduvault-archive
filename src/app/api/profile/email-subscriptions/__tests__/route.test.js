import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, PATCH } from '../route';
import { ObjectId } from 'mongodb';

const mockGetDb = vi.fn();
const mockGetUserFromCookie = vi.fn();
const mockWithApiHardening = vi.fn();
const mockAuditLog = vi.fn();

vi.mock('@/lib/mongodb', () => ({ getDb: mockGetDb }));
vi.mock('@/lib/api/auth', () => ({ getUserFromCookie: mockGetUserFromCookie }));
vi.mock('@/lib/api/hardening', () => ({ withApiHardening: mockWithApiHardening }));
vi.mock('@/lib/api/audit', () => ({ auditLog: mockAuditLog }));

describe('Email Subscriptions Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock withApiHardening to call the handler directly
    mockWithApiHardening.mockImplementation((req, opts, handler) => handler());
  });

  describe('GET /api/profile/email-subscriptions', () => {
    it('returns 401 when user is not authenticated', async () => {
      mockGetUserFromCookie.mockResolvedValue(null);

      const request = new Request('http://localhost:3000/api/profile/email-subscriptions', {
        method: 'GET',
      });

      const response = await GET(request);
      expect(response.status).toBe(401);
    });

    it('returns user preferences for authenticated user', async () => {
      const userId = new ObjectId();
      mockGetUserFromCookie.mockResolvedValue({ sub: userId.toString() });

      const mockUsers = {
        findOne: vi.fn().mockResolvedValue({
          _id: userId,
          emailSubscriptions: {
            purchaseReceipts: true,
            weeklyEarnings: false,
          },
        }),
      };

      const mockDb = {
        collection: vi.fn().mockReturnValue(mockUsers),
      };

      mockGetDb.mockResolvedValue(mockDb);

      const request = new Request('http://localhost:3000/api/profile/email-subscriptions', {
        method: 'GET',
      });

      const response = await GET(request);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.emailSubscriptions).toEqual({
        purchaseReceipts: true,
        weeklyEarnings: false,
        productUpdates: true, // defaults to true
        buyConfirmations: true,
        newFollower: true,
        materialApproved: true,
      });
    });

    it('returns 404 when authenticated user is not found in database', async () => {
      mockGetUserFromCookie.mockResolvedValue({ sub: new ObjectId().toString() });

      const mockUsers = {
        findOne: vi.fn().mockResolvedValue(null),
      };

      const mockDb = {
        collection: vi.fn().mockReturnValue(mockUsers),
      };

      mockGetDb.mockResolvedValue(mockDb);

      const request = new Request('http://localhost:3000/api/profile/email-subscriptions', {
        method: 'GET',
      });

      const response = await GET(request);
      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/profile/email-subscriptions', () => {
    it('returns 401 when user is not authenticated', async () => {
      mockGetUserFromCookie.mockResolvedValue(null);

      const request = new Request('http://localhost:3000/api/profile/email-subscriptions', {
        method: 'PATCH',
        body: JSON.stringify({ emailSubscriptions: { purchaseReceipts: false } }),
      });

      const response = await PATCH(request);
      expect(response.status).toBe(401);
    });

    it('updates only the authenticated user (no cross-account writes)', async () => {
      const userId = new ObjectId();
      mockGetUserFromCookie.mockResolvedValue({ sub: userId.toString() });

      const mockUsers = {
        updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
        findOne: vi.fn().mockResolvedValue({
          _id: userId,
          emailSubscriptions: { purchaseReceipts: false },
        }),
      };

      const mockDb = {
        collection: vi.fn().mockReturnValue(mockUsers),
      };

      mockGetDb.mockResolvedValue(mockDb);

      const request = new Request('http://localhost:3000/api/profile/email-subscriptions', {
        method: 'PATCH',
        body: JSON.stringify({
          emailSubscriptions: { purchaseReceipts: false },
        }),
      });

      const response = await PATCH(request);
      expect(response.status).toBe(200);

      // Verify updateOne was called with the authenticated user's ID, not a client-supplied ID
      expect(mockUsers.updateOne).toHaveBeenCalledWith(
        { _id: userId },
        expect.objectContaining({
          $set: expect.objectContaining({
            'emailSubscriptions.purchaseReceipts': false,
          }),
        })
      );
    });

    it('rejects attempts to modify preferences of other users', async () => {
      const currentUserId = new ObjectId();
      const otherUserId = new ObjectId();

      mockGetUserFromCookie.mockResolvedValue({ sub: currentUserId.toString() });

      const mockUsers = {
        updateOne: vi.fn().mockResolvedValue({ matchedCount: 0 }), // no match for other user's id
      };

      const mockDb = {
        collection: vi.fn().mockReturnValue(mockUsers),
      };

      mockGetDb.mockResolvedValue(mockDb);

      // Try to pass another user's ID in the body
      const request = new Request('http://localhost:3000/api/profile/email-subscriptions', {
        method: 'PATCH',
        body: JSON.stringify({
          // Attempting to specify a different user — this should be ignored
          userId: otherUserId.toString(),
          emailSubscriptions: { purchaseReceipts: false },
        }),
      });

      const response = await PATCH(request);

      // The route should always use the authenticated session, never the body
      expect(mockUsers.updateOne).toHaveBeenCalledWith(
        { _id: currentUserId },
        expect.anything()
      );
    });

    it('returns 400 for invalid preference keys', async () => {
      mockGetUserFromCookie.mockResolvedValue({ sub: new ObjectId().toString() });

      const request = new Request('http://localhost:3000/api/profile/email-subscriptions', {
        method: 'PATCH',
        body: JSON.stringify({
          emailSubscriptions: { invalidKey: true },
        }),
      });

      const response = await PATCH(request);
      expect(response.status).toBe(400);
    });

    it('returns 400 for non-boolean preference values', async () => {
      mockGetUserFromCookie.mockResolvedValue({ sub: new ObjectId().toString() });

      const request = new Request('http://localhost:3000/api/profile/email-subscriptions', {
        method: 'PATCH',
        body: JSON.stringify({
          emailSubscriptions: { purchaseReceipts: 'yes' },
        }),
      });

      const response = await PATCH(request);
      expect(response.status).toBe(400);
    });

    it('allows partial updates (only specified keys are changed)', async () => {
      const userId = new ObjectId();
      mockGetUserFromCookie.mockResolvedValue({ sub: userId.toString() });

      const mockUsers = {
        updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
        findOne: vi.fn().mockResolvedValue({
          _id: userId,
          emailSubscriptions: {
            purchaseReceipts: false,
            weeklyEarnings: true, // unchanged
          },
        }),
      };

      const mockDb = {
        collection: vi.fn().mockReturnValue(mockUsers),
      };

      mockGetDb.mockResolvedValue(mockDb);

      const request = new Request('http://localhost:3000/api/profile/email-subscriptions', {
        method: 'PATCH',
        body: JSON.stringify({
          emailSubscriptions: { purchaseReceipts: false },
        }),
      });

      const response = await PATCH(request);
      expect(response.status).toBe(200);

      // Verify only purchaseReceipts was updated in the $set
      expect(mockUsers.updateOne).toHaveBeenCalledWith(
        { _id: userId },
        expect.objectContaining({
          $set: expect.objectContaining({
            'emailSubscriptions.purchaseReceipts': false,
          }),
        })
      );

      // Other keys should not be touched (dot notation only includes purchaseReceipts)
      const callArgs = mockUsers.updateOne.mock.calls[0][1];
      expect(Object.keys(callArgs.$set)).toContain('emailSubscriptions.purchaseReceipts');
      expect(Object.keys(callArgs.$set)).not.toContain('emailSubscriptions.weeklyEarnings');
    });

    it('returns 404 when user is not found after update', async () => {
      mockGetUserFromCookie.mockResolvedValue({ sub: new ObjectId().toString() });

      const mockUsers = {
        updateOne: vi.fn().mockResolvedValue({ matchedCount: 0 }),
      };

      const mockDb = {
        collection: vi.fn().mockReturnValue(mockUsers),
      };

      mockGetDb.mockResolvedValue(mockDb);

      const request = new Request('http://localhost:3000/api/profile/email-subscriptions', {
        method: 'PATCH',
        body: JSON.stringify({
          emailSubscriptions: { purchaseReceipts: false },
        }),
      });

      const response = await PATCH(request);
      expect(response.status).toBe(404);
    });

    it('includes rate limiting via withApiHardening', async () => {
      const userId = new ObjectId();
      mockGetUserFromCookie.mockResolvedValue({ sub: userId.toString() });

      const mockUsers = {
        updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
        findOne: vi.fn().mockResolvedValue({ _id: userId, emailSubscriptions: {} }),
      };

      const mockDb = {
        collection: vi.fn().mockReturnValue(mockUsers),
      };

      mockGetDb.mockResolvedValue(mockDb);

      mockWithApiHardening.mockClear();
      mockWithApiHardening.mockImplementation((req, opts, handler) => {
        // Verify rate limit is configured
        expect(opts.rateLimit).toBeDefined();
        expect(opts.rateLimit.limit).toBe(30); // PATCH limit
        return handler();
      });

      const request = new Request('http://localhost:3000/api/profile/email-subscriptions', {
        method: 'PATCH',
        body: JSON.stringify({
          emailSubscriptions: { purchaseReceipts: false },
        }),
      });

      await PATCH(request);

      expect(mockWithApiHardening).toHaveBeenCalled();
    });
  });
});
