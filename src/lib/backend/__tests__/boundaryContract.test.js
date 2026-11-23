// @vitest-environment node
/**
 * src/lib/backend/__tests__/boundaryContract.test.js
 *
 * Vitest suite for Pagination, Filtering, and Authorization Boundary Contracts.
 * Validates normal, failure, retry, and authorization execution paths.
 */

import { describe, it, expect } from "vitest";
import { ObjectId } from "mongodb";
import {
  PAGINATION_TYPES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  AUTHORIZATION_BOUNDARIES,
  SENSITIVE_STORAGE_FIELDS,
  validatePaginationContract,
  validateCursorIntegrity,
  validateCatalogItemCompliance,
  validateFilterMatch,
  evaluateAuthorizationBoundary,
  verifyPaginationWalkStability,
  evaluateRetryContract,
  verifyPartialFailureRetryEligibility,
  parsePaginationContractParams,
} from "../boundaryContract.js";
import {
  buildMarketplaceDiscoveryQuery,
  buildMarketplaceSort,
  encodeMarketplaceCursor,
  decodeMarketplaceCursor,
  buildMarketplaceCursorClause,
  applyOwnershipRanking,
  scoreMarketplaceItem,
  applyMarketplaceRelevanceRanking,
} from "../marketplaceDiscovery.js";
import {
  STATUS_PRECEDENCE,
  sortRecords,
  paginateRecords,
} from "../sortContract.js";

describe("Boundary Contract Suite (Vitest)", () => {
  describe("Pagination Boundaries", () => {
    it("validates cursor pagination contract schema", () => {
      const validCursorPayload = {
        items: [{ _id: "1", title: "Note" }],
        pageSize: 10,
        hasNextPage: true,
        nextCursor: "eyJfaWQiOiIxIn0",
        paginationType: "cursor",
      };
      const check = validatePaginationContract(validCursorPayload);
      expect(check.valid).toBe(true);
      expect(check.errors).toEqual([]);

      const invalidPayload = {
        items: "not-an-array",
        pageSize: -5,
        hasNextPage: true,
        nextCursor: null,
        paginationType: "cursor",
      };
      const badCheck = validatePaginationContract(invalidPayload);
      expect(badCheck.valid).toBe(false);
      expect(badCheck.errors.length).toBeGreaterThanOrEqual(3);
    });

    it("validates offset pagination fallback schema", () => {
      const validOffsetPayload = {
        items: [{ id: "1" }],
        page: 1,
        pageSize: 20,
        total: 100,
        totalPages: 5,
        paginationType: "offset",
      };
      const check = validatePaginationContract(validOffsetPayload, { expectedType: "offset" });
      expect(check.valid).toBe(true);
    });

    it("enforces deterministic tie-breakers on identical timestamps", () => {
      const now = new Date();
      const records = [
        { _id: new ObjectId("00000000000000000000000b"), createdAt: now },
        { _id: new ObjectId("00000000000000000000000a"), createdAt: now },
      ];
      const sorted = sortRecords(records, { timestampField: "createdAt", descending: true });
      expect(String(sorted[0]._id)).toBe("00000000000000000000000a");
      expect(String(sorted[1]._id)).toBe("00000000000000000000000b");
    });

    it("rejects operator injection and tampered cursors", () => {
      const sort = buildMarketplaceSort("newest");
      const maliciousCursor = Buffer.from(JSON.stringify({
        _id: new ObjectId().toString(),
        createdAt: { $gt: "" },
        s: "createdAt,_id",
      })).toString("base64url");

      const check = validateCursorIntegrity(maliciousCursor, sort);
      expect(check.valid).toBe(false);
      expect(check.error).toMatch(/Invalid marketplace cursor/);
    });
  });

  describe("Filtering Boundaries & Invariants", () => {
    it("ensures public catalog queries strictly exclude soft-deleted, suspended, or infected items", () => {
      const compliance = validateCatalogItemCompliance({
        _id: new ObjectId(),
        title: "Test",
        isDeleted: true,
        quarantineState: "infected",
        storageKey: "ipfs://leaked-key",
      });

      expect(compliance.valid).toBe(false);
      expect(compliance.violations.some((v) => v.includes("storageKey"))).toBe(true);
      expect(compliance.violations.some((v) => v.includes("Soft-deleted"))).toBe(true);
      expect(compliance.violations.some((v) => v.includes("quarantineState"))).toBe(true);
    });

    it("verifies filter matching criteria", () => {
      const item = { subject: "mathematics", price: 25, rating: 4.5 };
      expect(validateFilterMatch(item, { subject: "mathematics", minPrice: 20, maxPrice: 30 }).matches).toBe(true);
      expect(validateFilterMatch(item, { subject: "physics" }).matches).toBe(false);
      expect(validateFilterMatch(item, { minPrice: 30 }).matches).toBe(false);
    });
  });

  describe("Authorization Boundaries", () => {
    it("denies unauthenticated calls to buyer or creator boundaries", () => {
      const buyerCheck = evaluateAuthorizationBoundary({
        boundary: AUTHORIZATION_BOUNDARIES.BUYER,
        actor: null,
      });
      expect(buyerCheck.allowed).toBe(false);
      expect(buyerCheck.statusCode).toBe(401);

      const creatorCheck = evaluateAuthorizationBoundary({
        boundary: AUTHORIZATION_BOUNDARIES.CREATOR,
        actor: null,
      });
      expect(creatorCheck.allowed).toBe(false);
      expect(creatorCheck.statusCode).toBe(401);
    });

    it("enforces tenant boundary isolation", () => {
      const actor = { sub: "user-1", walletAddress: "GUSER1" };
      const otherResource = { recipient: "user-2" };

      const check = evaluateAuthorizationBoundary({
        boundary: AUTHORIZATION_BOUNDARIES.BUYER,
        actor,
        resource: otherResource,
      });
      expect(check.allowed).toBe(false);
      expect(check.statusCode).toBe(403);
      expect(check.reason).toMatch(/Tenant boundary violation/);
    });

    it("blocks non-owners from editing material", () => {
      const creatorBob = { sub: "bob", role: "creator", walletAddress: "GBOB", permissions: ["creator:manage"] };
      const alicesMaterial = { userAddress: "GALICE" };

      const check = evaluateAuthorizationBoundary({
        boundary: AUTHORIZATION_BOUNDARIES.CREATOR,
        actor: creatorBob,
        resource: alicesMaterial,
        action: "write",
      });
      expect(check.allowed).toBe(false);
      expect(check.statusCode).toBe(403);
      expect(check.reason).toMatch(/not the material owner/);
    });

    it("verifies partial failure retry contract with user action requirement", () => {
      const safeDoc = { canRetrySafely: true, requiresUserAction: false, status: "unresolved" };
      expect(verifyPartialFailureRetryEligibility(safeDoc).canRetry).toBe(true);

      const blockedDoc = { canRetrySafely: false, requiresUserAction: true, status: "unresolved", userActionGuidance: "Please fund wallet" };
      const blockedCheck = verifyPartialFailureRetryEligibility(blockedDoc);
      expect(blockedCheck.canRetry).toBe(false);
      expect(blockedCheck.userActionRequired).toBe(true);
      expect(blockedCheck.reason).toBe("Please fund wallet");
    });
  });
});
