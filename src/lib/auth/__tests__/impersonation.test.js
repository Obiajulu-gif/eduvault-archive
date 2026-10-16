/**
 * Tests for Maintainer Impersonation
 * Issue #810
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  startImpersonationSession,
  endImpersonationSession,
  validateImpersonationAction,
  getActiveSession,
  requiresElevatedConfirmation,
} from '../impersonation.js';

vi.mock('../../logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockSessions = [];
const mockAuditLog = [];
const mockProfiles = [];

const mockCollection = (name) => {
  if (name === 'impersonation_sessions') {
    return {
      findOne: vi.fn((query) => {
        return Promise.resolve(
          mockSessions.find((s) => {
            if (query._id) return s._id === query._id;
            if (query.maintainerId && query.active)
              return (
                s.maintainerId === query.maintainerId &&
                s.active &&
                s.expiresAt > new Date()
              );
            return false;
          })
        );
      }),
      insertOne: vi.fn((doc) => {
        const id = `session_${mockSessions.length}`;
        mockSessions.push({ ...doc, _id: id });
        return Promise.resolve({ insertedId: id });
      }),
      updateOne: vi.fn(),
    };
  }

  if (name === 'audit_log') {
    return {
      insertOne: vi.fn((entry) => {
        mockAuditLog.push(entry);
        return Promise.resolve({ insertedId: `audit_${mockAuditLog.length}` });
      }),
      find: vi.fn(() => ({
        sort: vi.fn(() => ({
          limit: vi.fn(() => ({
            toArray: vi.fn(() => Promise.resolve(mockAuditLog)),
          })),
        })),
      })),
    };
  }

  if (name === 'profiles') {
    return {
      findOne: vi.fn((query) => {
        return Promise.resolve(
          mockProfiles.find((p) => p._id === query._id)
        );
      }),
    };
  }

  return {};
};

vi.mock('../../db/mongodb.js', () => ({
  getDb: vi.fn(() =>
    Promise.resolve({
      collection: mockCollection,
    })
  ),
}));

describe('Impersonation', () => {
  beforeEach(() => {
    mockSessions.length = 0;
    mockAuditLog.length = 0;
    mockProfiles.length = 0;

    // Add test users
    mockProfiles.push(
      {
        _id: 'maintainer1',
        email: 'maintainer@example.com',
        role: 'maintainer',
      },
      {
        _id: 'user1',
        email: 'user1@example.com',
        role: 'user',
      }
    );
  });

  describe('startImpersonationSession', () => {
    it('should create a new impersonation session', async () => {
      const session = await startImpersonationSession({
        maintainerId: 'maintainer1',
        targetUserId: 'user1',
        reason: 'Debug reported issue',
        ticketId: 'TICKET-123',
      });

      expect(session).toBeDefined();
      expect(session.maintainerId).toBe('maintainer1');
      expect(session.targetUserId).toBe('user1');
      expect(session.active).toBe(true);
      expect(session.allowedActions).toContain('view_profile');
      expect(session.blockedActions).toContain('delete_account');
    });

    it('should reject non-maintainer users', async () => {
      await expect(
        startImpersonationSession({
          maintainerId: 'user1',
          targetUserId: 'user1',
          reason: 'Test',
        })
      ).rejects.toThrow('Only maintainers can start impersonation');
    });

    it('should enforce maximum duration', async () => {
      const session = await startImpersonationSession({
        maintainerId: 'maintainer1',
        targetUserId: 'user1',
        reason: 'Test',
        duration: 10 * 60 * 60 * 1000, // 10 hours (over max)
      });

      const maxDuration = 60 * 60 * 1000; // 1 hour
      expect(session.duration).toBeLessThanOrEqual(maxDuration);
    });

    it('should prevent duplicate active sessions', async () => {
      await startImpersonationSession({
        maintainerId: 'maintainer1',
        targetUserId: 'user1',
        reason: 'First session',
      });

      mockSessions[0].expiresAt = new Date(Date.now() + 30 * 60 * 1000);

      await expect(
        startImpersonationSession({
          maintainerId: 'maintainer1',
          targetUserId: 'user1',
          reason: 'Duplicate session',
        })
      ).rejects.toThrow('Active impersonation session already exists');
    });

    it('should log session start in audit log', async () => {
      await startImpersonationSession({
        maintainerId: 'maintainer1',
        targetUserId: 'user1',
        reason: 'Test audit',
      });

      expect(mockAuditLog).toHaveLength(1);
      expect(mockAuditLog[0].action).toBe('impersonation_started');
    });
  });

  describe('validateImpersonationAction', () => {
    it('should allow whitelisted actions', async () => {
      const session = await startImpersonationSession({
        maintainerId: 'maintainer1',
        targetUserId: 'user1',
        reason: 'Test',
      });

      const result = await validateImpersonationAction(
        session.sessionId,
        'view_profile'
      );

      expect(result.allowed).toBe(true);
    });

    it('should block sensitive actions', async () => {
      const session = await startImpersonationSession({
        maintainerId: 'maintainer1',
        targetUserId: 'user1',
        reason: 'Test',
      });

      const result = await validateImpersonationAction(
        session.sessionId,
        'delete_account'
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not permitted');
    });

    it('should detect expired sessions', async () => {
      const session = await startImpersonationSession({
        maintainerId: 'maintainer1',
        targetUserId: 'user1',
        reason: 'Test',
        duration: -1000, // Expired
      });

      const result = await validateImpersonationAction(
        session.sessionId,
        'view_profile'
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('expired');
    });

    it('should log blocked action attempts', async () => {
      const session = await startImpersonationSession({
        maintainerId: 'maintainer1',
        targetUserId: 'user1',
        reason: 'Test',
      });

      await validateImpersonationAction(
        session.sessionId,
        'change_password'
      );

      const blockedEntries = mockAuditLog.filter(
        (e) => e.action === 'impersonation_action_blocked'
      );

      expect(blockedEntries).toHaveLength(1);
      expect(blockedEntries[0].blockedAction).toBe('change_password');
    });
  });

  describe('endImpersonationSession', () => {
    it('should deactivate session', async () => {
      const session = await startImpersonationSession({
        maintainerId: 'maintainer1',
        targetUserId: 'user1',
        reason: 'Test',
      });

      await endImpersonationSession(session.sessionId);

      // Session should be updated to inactive
      const activeSession = await getActiveSession('maintainer1');
      expect(activeSession).toBeUndefined();
    });

    it('should log session end', async () => {
      const session = await startImpersonationSession({
        maintainerId: 'maintainer1',
        targetUserId: 'user1',
        reason: 'Test',
      });

      await endImpersonationSession(session.sessionId);

      const endEntries = mockAuditLog.filter(
        (e) => e.action === 'impersonation_ended'
      );

      expect(endEntries.length).toBeGreaterThan(0);
    });
  });

  describe('requiresElevatedConfirmation', () => {
    it('should identify sensitive actions', () => {
      expect(requiresElevatedConfirmation('purchase_material')).toBe(true);
      expect(requiresElevatedConfirmation('update_profile')).toBe(true);
    });

    it('should not flag read-only actions', () => {
      expect(requiresElevatedConfirmation('view_profile')).toBe(false);
      expect(requiresElevatedConfirmation('search_marketplace')).toBe(false);
    });
  });
});
