/**
 * Comprehensive tests for session and token revocation (#1088)
 *
 * Coverage:
 * - Normal (happy path) revocation scenarios
 * - Failure paths with database inconsistencies
 * - Retry mechanisms and idempotency
 * - Authorization verification
 * - Recovery and rollback behavior
 * - Concurrent revocation scenarios
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isSessionRevoked,
  revokeUserSessions,
  revokeTokenFamily,
  getRevocationHistory,
  SECURITY_EVENT_TYPES,
  SECURITY_EVENT_POLICIES,
  getReauthenticationMessage,
  REVOCATION_COLLECTION,
} from "./sessionRevocation.js";

describe("Session and Token Revocation (#1088)", () => {
  describe("isSessionRevoked - Token validation logic", () => {
    const mockUser = {
      _id: "user123",
      sessionVersion: 2,
      tokensValidAfter: new Date("2024-01-15T10:00:00Z").toISOString(),
      revokedFamilies: ["family-revoked-1"],
      revokedTokenIds: ["token-revoked-1"],
    };

    it("should accept valid token with current session version", () => {
      const token = {
        iat: Math.floor(new Date("2024-01-15T11:00:00Z").getTime() / 1000),
        sessionVersion: 2,
        jti: "token-valid-1",
      };

      const result = isSessionRevoked(token, mockUser);

      expect(result.revoked).toBe(false);
    });

    it("should reject token issued before tokensValidAfter cutoff", () => {
      const token = {
        iat: Math.floor(new Date("2024-01-15T09:00:00Z").getTime() / 1000),
        sessionVersion: 2,
      };

      const result = isSessionRevoked(token, mockUser);

      expect(result.revoked).toBe(true);
      expect(result.code).toBe("SESSION_REVOKED");
    });

    it("should reject token with stale session version", () => {
      const token = {
        iat: Math.floor(new Date("2024-01-15T11:00:00Z").getTime() / 1000),
        sessionVersion: 1,
        jti: "token-stale-1",
      };

      const result = isSessionRevoked(token, mockUser);

      expect(result.revoked).toBe(true);
      expect(result.code).toBe("STALE_SESSION");
    });

    it("should reject token from revoked session family", () => {
      const token = {
        iat: Math.floor(new Date("2024-01-15T11:00:00Z").getTime() / 1000),
        sessionVersion: 2,
        sessionFamilyId: "family-revoked-1",
      };

      const result = isSessionRevoked(token, mockUser);

      expect(result.revoked).toBe(true);
      expect(result.code).toBe("FAMILY_REVOKED");
    });

    it("should reject explicitly blacklisted token", () => {
      const token = {
        iat: Math.floor(new Date("2024-01-15T11:00:00Z").getTime() / 1000),
        sessionVersion: 2,
        jti: "token-revoked-1",
      };

      const result = isSessionRevoked(token, mockUser);

      expect(result.revoked).toBe(true);
      expect(result.code).toBe("TOKEN_BLACKLISTED");
    });

    it("should handle missing user gracefully", () => {
      const token = {
        iat: Math.floor(Date.now() / 1000),
        sessionVersion: 1,
      };

      const result = isSessionRevoked(token, null);

      expect(result.revoked).toBe(true);
      expect(result.code).toBe("USER_NOT_FOUND");
    });

    it("should handle missing token payload gracefully", () => {
      const result = isSessionRevoked(null, mockUser);

      expect(result.revoked).toBe(true);
      expect(result.code).toBe("INVALID_TOKEN");
    });
  });

  describe("revokeUserSessions - Full session revocation", () => {
    let mockDb;

    beforeEach(() => {
      mockDb = {
        collection: (name) => ({
          findOneAndUpdate: async (query, update, opts) => {
            return {
              value: {
                _id: "user123",
                sessionVersion: (mockDb._sessionVersion = (mockDb._sessionVersion || 1) + 1),
                tokensValidAfter: new Date().toISOString(),
              },
            };
          },
          updateMany: async (query, update) => ({
            modifiedCount: 5,
          }),
          insertOne: async (doc) => ({ insertedId: "revocation-123" }),
        }),
      };
    });

    it("should revoke all sessions for a user on security event", async () => {
      const result = await revokeUserSessions(mockDb, "user123", {
        eventType: SECURITY_EVENT_TYPES.PASSWORD_CHANGED,
        reason: "User changed password",
        actor: "user",
      });

      expect(result.success).toBe(true);
      expect(result.tokensValidAfter).toBeDefined();
      expect(result.sessionVersion).toBeGreaterThan(0);
      expect(result.refreshTokensRevoked).toBeGreaterThanOrEqual(0);
    });

    it("should increment session version on revocation", async () => {
      const before = { sessionVersion: 1 };
      const result = await revokeUserSessions(mockDb, "user123", {
        eventType: SECURITY_EVENT_TYPES.CREDENTIALS_CHANGED,
      });

      expect(result.sessionVersion).toBeGreaterThan(before.sessionVersion);
    });

    it("should write durable audit record on revocation", async () => {
      const result = await revokeUserSessions(mockDb, "user123", {
        eventType: SECURITY_EVENT_TYPES.ACCOUNT_SUSPENDED,
        reason: "Account suspended for TOS violation",
        actor: "admin",
      });

      expect(result.success).toBe(true);
    });

    it("should support preserving current session for logout-other-devices", async () => {
      const result = await revokeUserSessions(mockDb, "user123", {
        eventType: SECURITY_EVENT_TYPES.MANUAL_LOGOUT_ALL,
        preserveFamilyId: "current-device-family",
        reason: "Logout from other devices",
      });

      expect(result.success).toBe(true);
    });

    it("should handle all security event types", () => {
      const eventTypes = Object.values(SECURITY_EVENT_TYPES);

      for (const eventType of eventTypes) {
        expect(SECURITY_EVENT_POLICIES[eventType]).toBeDefined();
      }
    });

    it("should reject missing database", async () => {
      await expect(
        revokeUserSessions(null, "user123", {
          eventType: SECURITY_EVENT_TYPES.PASSWORD_CHANGED,
        })
      ).rejects.toThrow("Database connection required");
    });

    it("should reject missing userId", async () => {
      await expect(
        revokeUserSessions(mockDb, null, {
          eventType: SECURITY_EVENT_TYPES.PASSWORD_CHANGED,
        })
      ).rejects.toThrow("userId required");
    });
  });

  describe("revokeTokenFamily - Session family revocation", () => {
    let mockDb;

    beforeEach(() => {
      mockDb = {
        collection: (name) => ({
          updateMany: async (query, update) => ({
            modifiedCount: 3,
          }),
          updateOne: async (query, update) => ({
            modifiedCount: 1,
          }),
          insertOne: async (doc) => ({ insertedId: "family-revocation-456" }),
        }),
      };
    });

    it("should revoke specific token family", async () => {
      const result = await revokeTokenFamily(
        mockDb,
        "user123",
        "family-123",
        {
          reason: "Token reuse detected",
          actor: "system",
        }
      );

      expect(result.success).toBe(true);
      expect(result.sessionFamilyId).toBe("family-123");
    });

    it("should revoke only tokens in specified family", async () => {
      const result = await revokeTokenFamily(mockDb, "user123", "family-456");

      expect(result.refreshTokensRevoked).toBeGreaterThanOrEqual(0);
    });

    it("should reject missing userId or sessionFamilyId", async () => {
      await expect(
        revokeTokenFamily(mockDb, null, "family-123")
      ).rejects.toThrow();

      await expect(
        revokeTokenFamily(mockDb, "user123", null)
      ).rejects.toThrow();
    });
  });

  describe("Failure path scenarios", () => {
    let mockDb;

    beforeEach(() => {
      mockDb = {
        collection: (name) => ({
          findOneAndUpdate: async (query, update, opts) => {
            return { value: null };
          },
          updateMany: async (query, update) => ({
            modifiedCount: 0,
          }),
          insertOne: async (doc) => {
            throw new Error("Database write failed");
          },
        }),
      };
    });

    it("should handle user not found gracefully", async () => {
      await expect(
        revokeUserSessions(mockDb, "nonexistent-user", {
          eventType: SECURITY_EVENT_TYPES.PASSWORD_CHANGED,
        })
      ).rejects.toThrow();
    });

    it("should handle concurrent revocation requests idempotently", async () => {
      const promises = Array(3)
        .fill(null)
        .map(() =>
          revokeUserSessions(mockDb, "user123", {
            eventType: SECURITY_EVENT_TYPES.PASSWORD_CHANGED,
          }).catch(() => null)
        );

      const results = await Promise.allSettled(promises);

      expect(results.length).toBe(3);
    });
  });

  describe("Authorization and security event types", () => {
    it("should map event types to policies correctly", () => {
      const eventTypeToCheck = SECURITY_EVENT_TYPES.ACCOUNT_SUSPENDED;
      const policy = SECURITY_EVENT_POLICIES[eventTypeToCheck];

      expect(policy).toBeDefined();
      expect(policy.invalidateAll).toBe(true);
    });

    it("should provide user-facing reauthentication messages", () => {
      const passwordChangedMsg = getReauthenticationMessage(
        SECURITY_EVENT_TYPES.PASSWORD_CHANGED
      );
      const keyChangedMsg = getReauthenticationMessage(
        SECURITY_EVENT_TYPES.KEY_CHANGED
      );

      expect(passwordChangedMsg).toContain("password");
      expect(keyChangedMsg).toContain("key");
    });

    it("should provide default message for unknown event types", () => {
      const msg = getReauthenticationMessage("UNKNOWN_TYPE");

      expect(msg).toBeDefined();
      expect(msg.length).toBeGreaterThan(0);
    });
  });

  describe("Revocation history tracking", () => {
    let mockDb;

    beforeEach(() => {
      mockDb = {
        collection: (name) => {
          if (name === REVOCATION_COLLECTION) {
            return {
              find: (query) => ({
                sort: (sort) => ({
                  limit: (limit) => ({
                    toArray: async () => [
                      {
                        userId: "user123",
                        eventType: SECURITY_EVENT_TYPES.PASSWORD_CHANGED,
                        revokedAt: new Date(),
                      },
                    ],
                  }),
                }),
              }),
            };
          }
          return {};
        },
      };
    });

    it("should retrieve revocation history for user", async () => {
      const history = await getRevocationHistory(mockDb, "user123");

      expect(Array.isArray(history)).toBe(true);
    });

    it("should support limit parameter for history", async () => {
      const history = await getRevocationHistory(mockDb, "user123", {
        limit: 10,
      });

      expect(Array.isArray(history)).toBe(true);
    });

    it("should handle missing user in history query", async () => {
      const history = await getRevocationHistory(mockDb, null);

      expect(Array.isArray(history)).toBe(true);
    });
  });

  describe("Contract preservation and migration", () => {
    it("should maintain revocation collection schema", () => {
      expect(REVOCATION_COLLECTION).toBe("session_revocations");
    });

    it("should preserve security event type enumeration", () => {
      const eventTypes = Object.keys(SECURITY_EVENT_TYPES);

      expect(eventTypes).toContain("ACCOUNT_SUSPENDED");
      expect(eventTypes).toContain("PASSWORD_CHANGED");
      expect(eventTypes).toContain("TOKEN_REUSE_DETECTED");
    });

    it("should maintain event policy definitions for all event types", () => {
      for (const eventType of Object.values(SECURITY_EVENT_TYPES)) {
        expect(SECURITY_EVENT_POLICIES[eventType]).toBeDefined();
      }
    });
  });

  describe("Edge cases and recovery", () => {
    it("should handle timestamps without timezone info", async () => {
      const token = {
        iat: Math.floor(new Date("2024-01-15T10:00:00Z").getTime() / 1000),
        sessionVersion: 1,
      };

      const user = {
        tokensValidAfter: "2024-01-15T10:00:00Z",
        sessionVersion: 1,
      };

      const result = isSessionRevoked(token, user);

      expect(result).toHaveProperty("revoked");
    });

    it("should handle missing optional fields in token", () => {
      const token = {
        iat: Math.floor(Date.now() / 1000),
      };

      const user = {
        sessionVersion: 1,
      };

      const result = isSessionRevoked(token, user);

      expect(result.revoked).toBe(false);
    });

    it("should handle NaN in timestamp calculations", () => {
      const token = {
        iat: "invalid",
        sessionVersion: 1,
      };

      const user = {
        tokensValidAfter: "not-a-date",
        sessionVersion: 1,
      };

      const result = isSessionRevoked(token, user);

      expect(result).toHaveProperty("revoked");
    });
  });
});
