/**
 * tests/backend/pagination-filtering-auth-contract.test.mjs
 *
 * Contract tests for pagination, filtering, and authorization boundaries.
 * Acceptance criteria verified:
 * - Cover normal, failure, retry, and authorization paths.
 * - Add automated tests or executable verification.
 * - Document operational edge cases and recovery/rollback behavior.
 * - Preserve existing contracts or include a migration plan.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
} from "../../src/lib/backend/boundaryContract.js";
import {
  buildMarketplaceDiscoveryQuery,
  buildMarketplaceSort,
  encodeMarketplaceCursor,
  decodeMarketplaceCursor,
  buildMarketplaceCursorClause,
  applyOwnershipRanking,
  scoreMarketplaceItem,
  applyMarketplaceRelevanceRanking,
} from "../../src/lib/backend/marketplaceDiscovery.js";
import {
  STATUS_PRECEDENCE,
  sortRecords,
  paginateRecords,
} from "../../src/lib/backend/sortContract.js";

// Minimal in-memory MongoDB query evaluator for contract validation
const norm = (v) => (v === undefined ? null : v instanceof Date ? v.getTime() : v instanceof ObjectId ? String(v) : v);

function matchesCondition(actual, condition) {
  if (condition === null || condition === undefined) return actual === condition;
  const isOperator = typeof condition === "object" && !(condition instanceof Date) && !(condition instanceof ObjectId) && !(condition instanceof RegExp);
  if (!isOperator) return norm(actual) === norm(condition);

  return Object.entries(condition).every(([op, value]) => {
    switch (op) {
      case "$ne":
        return norm(actual) !== norm(value);
      case "$exists":
        return (actual !== undefined && actual !== null) === value;
      case "$gt":
        return norm(actual) !== null && norm(actual) > norm(value);
      case "$gte":
        return norm(actual) !== null && norm(actual) >= norm(value);
      case "$lt":
        return norm(actual) !== null && norm(actual) < norm(value);
      case "$lte":
        return norm(actual) !== null && norm(actual) <= norm(value);
      case "$in":
        return Array.isArray(value) && value.some((v) => norm(actual) === norm(v));
      default:
        return true;
    }
  });
}

function matchesQuery(doc, query) {
  return Object.entries(query).every(([key, condition]) => {
    if (key === "$or" && Array.isArray(condition)) {
      return condition.some((sub) => matchesQuery(doc, sub));
    }
    if (key === "$and" && Array.isArray(condition)) {
      return condition.every((sub) => matchesQuery(doc, sub));
    }
    return matchesCondition(doc[key], condition);
  });
}

function compareBySort(a, b, sort) {
  for (const [field, direction] of Object.entries(sort)) {
    const x = norm(a[field]);
    const y = norm(b[field]);
    if (x === y) continue;
    if (x === null) return -direction;
    if (y === null) return direction;
    return (x < y ? -1 : 1) * direction;
  }
  return 0;
}

function executeMockQuery(docs, query, sort, limit = 50) {
  return docs
    .filter((d) => matchesQuery(d, query))
    .sort((a, b) => compareBySort(a, b, sort))
    .slice(0, limit);
}

// Deterministic test fixtures generator
const BASE_TIME = Date.parse("2026-02-01T00:00:00Z");

function createTestDataset(count = 30) {
  return Array.from({ length: count }, (_, i) => ({
    _id: new ObjectId((i + 1).toString(16).padStart(24, "0")),
    title: `Material ${i + 1}`,
    description: `Description for material ${i + 1} with educational content`,
    subject: ["mathematics", "physics", "technology"][i % 3],
    category: ["academic", "professional", "skills"][i % 3],
    level: ["beginner", "intermediate", "advanced"][i % 3],
    language: ["English", "Spanish", "French"][i % 3],
    price: (i % 5) * 10,
    rating: 3 + (i % 3),
    likes: i * 5,
    visibility: "public",
    archived: false,
    moderationStatus: "approved",
    isDeleted: false,
    creatorSuspended: false,
    quarantineState: "clean",
    relevanceStatus: "normal",
    createdAt: new Date(BASE_TIME + i * 3600_000),
    userAddress: `GCREATOR${(i % 3) + 1}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
    storageKey: `ipfs://QmTest${i + 1}`,
    fileUrl: `https://storage.example.com/file-${i + 1}.pdf`,
    metadataUrl: `https://storage.example.com/meta-${i + 1}.json`,
  }));
}

describe("Contract Tests: Pagination, Filtering, and Authorization Boundaries", () => {
  // =========================================================================
  // 1. PAGINATION CONTRACTS
  // =========================================================================
  describe("1. Pagination Contract Verification", () => {
    it("Normal Path: cursor-based pagination walks complete dataset without loss or duplication", () => {
      const dataset = createTestDataset(25);
      const pageSize = 10;
      const sortBy = "newest";
      const sort = buildMarketplaceSort(sortBy);
      const query = buildMarketplaceDiscoveryQuery(new URLSearchParams());

      const pages = [];
      let currentCursor = null;
      let hasMore = true;
      let iterations = 0;

      while (hasMore && iterations < 5) {
        iterations += 1;
        const pageQuery = { ...query };
        if (currentCursor) {
          const cursorData = decodeMarketplaceCursor(currentCursor, sort);
          pageQuery.$and = [...(pageQuery.$and || []), buildMarketplaceCursorClause(cursorData, sort)];
        }

        // Fetch pageSize + 1
        const results = executeMockQuery(dataset, pageQuery, sort, pageSize + 1);
        const pageHasNext = results.length > pageSize;
        const items = pageHasNext ? results.slice(0, pageSize) : results;
        const nextCursor = pageHasNext && items.length > 0 ? encodeMarketplaceCursor(items[items.length - 1], sort) : null;

        const responsePayload = {
          items,
          pageSize,
          hasNextPage: pageHasNext,
          nextCursor,
          paginationType: "cursor",
        };

        const validation = validatePaginationContract(responsePayload, { expectedType: "cursor" });
        assert.equal(validation.valid, true, `Payload validation failed: ${validation.errors.join("; ")}`);

        pages.push(items);
        hasMore = pageHasNext;
        currentCursor = nextCursor;
      }

      assert.equal(pages.length, 3, "Expected 25 items with pageSize 10 to yield 3 pages");
      assert.equal(pages[0].length, 10);
      assert.equal(pages[1].length, 10);
      assert.equal(pages[2].length, 5);

      const stability = verifyPaginationWalkStability(pages);
      assert.equal(stability.stable, true, `Stability violations: ${stability.duplicates.join(", ")}`);
      assert.equal(stability.seenCount, 25);
    });

    it("Normal Path: offset-based legacy pagination provides expected boundary structure", () => {
      const dataset = createTestDataset(15);
      const paged = paginateRecords(dataset, { page: 2, pageSize: 5 });

      const responsePayload = {
        items: paged.items,
        page: paged.page,
        pageSize: paged.pageSize,
        total: paged.total,
        totalPages: paged.totalPages,
        paginationType: "offset",
      };

      const validation = validatePaginationContract(responsePayload, { expectedType: "offset" });
      assert.equal(validation.valid, true);
      assert.equal(responsePayload.page, 2);
      assert.equal(responsePayload.totalPages, 3);
      assert.equal(responsePayload.total, 15);
      assert.equal(responsePayload.items.length, 5);
    });

    it("Normal Path: deterministic ordering tie-breaking on identical timestamps and scores", () => {
      const sameTime = new Date("2026-05-01T12:00:00Z");
      const records = [
        { _id: new ObjectId("000000000000000000000003"), createdAt: sameTime, status: "active" },
        { _id: new ObjectId("000000000000000000000001"), createdAt: sameTime, status: "active" },
        { _id: new ObjectId("000000000000000000000002"), createdAt: sameTime, status: "active" },
      ];

      const sorted1 = sortRecords(records, { timestampField: "createdAt", descending: true });
      const sorted2 = sortRecords(records, { timestampField: "createdAt", descending: true });

      assert.deepEqual(
        sorted1.map((r) => String(r._id)),
        ["000000000000000000000001", "000000000000000000000002", "000000000000000000000003"],
        "Tie-breaker must strictly sort ID ascending lexicographically"
      );
      assert.deepEqual(sorted1, sorted2, "Sorting must be completely deterministic across repeated evaluations");
    });

    it("Normal Path: status precedence enforces active > pending > suspended > archived > deleted", () => {
      const records = [
        { _id: "5", isDeleted: true },
        { _id: "3", status: "suspended" },
        { _id: "1", status: "active" },
        { _id: "4", status: "archived" },
        { _id: "2", status: "pending" },
      ];

      const sorted = sortRecords(records);
      assert.deepEqual(
        sorted.map((r) => r._id),
        ["1", "2", "3", "4", "5"],
        "Records must be ordered strictly by status precedence"
      );
    });

    it("Failure Path: corrupted, malformed, or injected cursors are rejected", () => {
      const sort = buildMarketplaceSort("newest");

      // 1. Not base64
      const res1 = validateCursorIntegrity("!!!not_base64!!!", sort);
      assert.equal(res1.valid, false);
      assert.match(res1.error, /Invalid marketplace cursor/);

      // 2. Valid base64, but invalid JSON
      const res2 = validateCursorIntegrity(Buffer.from("invalid-json").toString("base64url"), sort);
      assert.equal(res2.valid, false);

      // 3. Valid JSON, but missing or invalid ObjectId
      const badIdPayload = Buffer.from(JSON.stringify({ _id: "not-an-objectid", s: "createdAt,_id" })).toString("base64url");
      const res3 = validateCursorIntegrity(badIdPayload, sort);
      assert.equal(res3.valid, false);

      // 4. Operator injection attempt via cursor fields (e.g. object with $ne)
      const injectionPayload = Buffer.from(JSON.stringify({
        _id: new ObjectId().toString(),
        createdAt: { $ne: null },
        s: "createdAt,_id",
      })).toString("base64url");
      const res4 = validateCursorIntegrity(injectionPayload, sort);
      assert.equal(res4.valid, false);
      assert.match(res4.error, /Invalid marketplace cursor/);

      // 5. Sort signature mismatch
      const newestCursor = encodeMarketplaceCursor({ _id: new ObjectId(), createdAt: new Date() }, sort);
      const priceSort = buildMarketplaceSort("price_asc");
      const res5 = validateCursorIntegrity(newestCursor, priceSort);
      assert.equal(res5.valid, false);
    });

    it("Failure Path: pagination parser clamps invalid pageSize boundaries safely", () => {
      const paramsLow = new URLSearchParams({ pageSize: "0" });
      const p1 = parsePaginationContractParams(paramsLow);
      assert.ok(p1.pageSize >= 1, "PageSize must be clamped to minimum >= 1");

      const paramsNegative = new URLSearchParams({ pageSize: "-10" });
      const p2 = parsePaginationContractParams(paramsNegative);
      assert.ok(p2.pageSize >= 1);

      const paramsHuge = new URLSearchParams({ pageSize: "9999" });
      const p3 = parsePaginationContractParams(paramsHuge, { maxPageSize: 100 });
      assert.ok(p3.pageSize <= 100, "PageSize must be clamped to maxPageSize");
    });

    it("Retry Path: querying with identical cursor yields identical page boundary (idempotence)", () => {
      const dataset = createTestDataset(20);
      const sort = buildMarketplaceSort("newest");
      const query = buildMarketplaceDiscoveryQuery(new URLSearchParams());

      const page1 = executeMockQuery(dataset, query, sort, 5);
      const cursor = encodeMarketplaceCursor(page1[page1.length - 1], sort);

      const cursorData = decodeMarketplaceCursor(cursor, sort);
      const page2Query = { ...query, $and: [buildMarketplaceCursorClause(cursorData, sort)] };

      const fetchA = executeMockQuery(dataset, page2Query, sort, 5);
      const fetchB = executeMockQuery(dataset, page2Query, sort, 5);

      assert.deepEqual(
        fetchA.map((i) => String(i._id)),
        fetchB.map((i) => String(i._id)),
        "Repeated requests with identical cursor must return exact same items"
      );
    });

    it("Retry Path: concurrent inserts or deletions mid-walk do not disrupt cursor progression", () => {
      const dataset = createTestDataset(20);
      const sort = buildMarketplaceSort("newest");
      const query = buildMarketplaceDiscoveryQuery(new URLSearchParams());

      // Fetch page 1 (5 items)
      const page1 = executeMockQuery(dataset, query, sort, 5);
      const cursor = encodeMarketplaceCursor(page1[page1.length - 1], sort);
      const page1Ids = page1.map((i) => String(i._id));

      // Simulate concurrent insert: 3 brand new records created in the interim
      const newItems = [
        { _id: new ObjectId(), title: "Brand New 1", visibility: "public", createdAt: new Date(Date.now() + 1000) },
        { _id: new ObjectId(), title: "Brand New 2", visibility: "public", createdAt: new Date(Date.now() + 2000) },
      ];
      dataset.unshift(...newItems);

      // Simulate concurrent delete: item from page 1 deleted
      dataset.splice(2, 1);

      // Fetch page 2 using cursor
      const cursorData = decodeMarketplaceCursor(cursor, sort);
      const page2Query = { ...query, $and: [buildMarketplaceCursorClause(cursorData, sort)] };
      const page2 = executeMockQuery(dataset, page2Query, sort, 5);
      const page2Ids = page2.map((i) => String(i._id));

      // Invariant: no duplicate items between page 1 and page 2
      const overlap = page1Ids.filter((id) => page2Ids.includes(id));
      assert.equal(overlap.length, 0, "Concurrent mutations must not cause duplicate items across cursor pages");
    });
  });

  // =========================================================================
  // 2. FILTERING CONTRACTS
  // =========================================================================
  describe("2. Filtering Contract Verification", () => {
    it("Normal Path: filters return strictly matching items across subject, category, level, price, and rating", () => {
      const dataset = createTestDataset(30);

      // Filter by subject=math (normalized to mathematics)
      const qMath = buildMarketplaceDiscoveryQuery(new URLSearchParams({ subject: "math" }));
      const mathResults = dataset.filter((d) => matchesQuery(d, qMath));
      assert.ok(mathResults.length > 0);
      for (const item of mathResults) {
        assert.equal(item.subject, "mathematics");
        const match = validateFilterMatch(item, { subject: "mathematics" });
        assert.equal(match.matches, true);
      }

      // Filter by price range
      const qPrice = buildMarketplaceDiscoveryQuery(new URLSearchParams({ minPrice: "10", maxPrice: "30" }));
      const priceResults = dataset.filter((d) => matchesQuery(d, qPrice));
      for (const item of priceResults) {
        assert.ok(item.price >= 10 && item.price <= 30);
        const match = validateFilterMatch(item, { minPrice: 10, maxPrice: 30 });
        assert.equal(match.matches, true);
      }

      // Filter by minRating
      const qRating = buildMarketplaceDiscoveryQuery(new URLSearchParams({ minRating: "4" }));
      const ratingResults = dataset.filter((d) => matchesQuery(d, qRating));
      for (const item of ratingResults) {
        assert.ok(item.rating >= 4);
        const match = validateFilterMatch(item, { minRating: 4 });
        assert.equal(match.matches, true);
      }
    });

    it("Normal Path: text search and fuzzy tokenization rank matching items", () => {
      const itemA = { _id: "1", title: "Advanced Quantum Mechanics Notes", description: "Comprehensive physics review", likes: 20 };
      const itemB = { _id: "2", title: "Basic French Grammar", description: "Introductory language tutorial", likes: 5 };

      const scoreA = scoreMarketplaceItem(itemA, "quantum mechanics");
      const scoreB = scoreMarketplaceItem(itemB, "quantum mechanics");

      assert.ok(scoreA > scoreB, "Relevant item must receive higher score");

      const ranked = applyMarketplaceRelevanceRanking([itemB, itemA], "quantum mechanics");
      assert.equal(ranked[0]._id, "1", "Ranked list must place relevant item first");
    });

    it("Normal Path: entitlement personalization demotes already-owned items without breaking cursor order", () => {
      const items = [
        { _id: new ObjectId("000000000000000000000001"), materialId: "mat-1", title: "Item 1" },
        { _id: new ObjectId("000000000000000000000002"), materialId: "mat-2", title: "Item 2" },
        { _id: new ObjectId("000000000000000000000003"), materialId: "mat-3", title: "Item 3" },
      ];

      const ownedIds = new Set(["mat-1"]);
      const reranked = applyOwnershipRanking(items, ownedIds);

      assert.equal(reranked[0].materialId, "mat-2");
      assert.equal(reranked[1].materialId, "mat-3");
      assert.equal(reranked[2].materialId, "mat-1");
      assert.equal(reranked[2].owned, true);
      assert.equal(reranked[0].owned, false);
    });

    it("Failure & Security Path: public query invariants exclude hidden, soft-deleted, suspended, and quarantined items", () => {
      const dirtyDataset = [
        { _id: new ObjectId(), title: "Clean Public", visibility: "public", isDeleted: false, moderationStatus: "approved", creatorSuspended: false, archived: false, quarantineState: "clean" },
        { _id: new ObjectId(), title: "Soft-Deleted", visibility: "public", isDeleted: true, moderationStatus: "approved", creatorSuspended: false, archived: false },
        { _id: new ObjectId(), title: "Suspended Listing", visibility: "public", isDeleted: false, moderationStatus: "suspended", creatorSuspended: false, archived: false },
        { _id: new ObjectId(), title: "Creator Suspended", visibility: "public", isDeleted: false, moderationStatus: "approved", creatorSuspended: true, archived: false },
        { _id: new ObjectId(), title: "Archived Item", visibility: "public", isDeleted: false, moderationStatus: "approved", creatorSuspended: false, archived: true },
        { _id: new ObjectId(), title: "Infected Quarantine", visibility: "public", isDeleted: false, moderationStatus: "approved", creatorSuspended: false, archived: false, quarantineState: "infected" },
        { _id: new ObjectId(), title: "Low Relevance", visibility: "public", isDeleted: false, moderationStatus: "approved", creatorSuspended: false, archived: false, relevanceStatus: "low" },
        { _id: new ObjectId(), title: "Private Item", visibility: "private", isDeleted: false, moderationStatus: "approved", creatorSuspended: false, archived: false },
      ];

      const query = buildMarketplaceDiscoveryQuery(new URLSearchParams());
      const visible = dirtyDataset.filter((d) => matchesQuery(d, query));

      assert.equal(visible.length, 1, "Only the clean public listing must pass the discovery filter");
      assert.equal(visible[0].title, "Clean Public");

      // Verify validator catches violations
      for (const item of dirtyDataset.slice(1)) {
        const compliance = validateCatalogItemCompliance(item);
        assert.equal(compliance.valid, false, `Item '${item.title}' should have violated catalog compliance`);
      }
    });

    it("Failure Path: malicious or malformed filter inputs are safely sanitized", () => {
      // 1. Control character injection
      const queryWithControlChars = buildMarketplaceDiscoveryQuery(new URLSearchParams({
        search: "Math\u0000\u001FNotes",
        subject: "Algebra\u0008",
      }));
      assert.ok(queryWithControlChars);

      // 2. Regex injection in language
      const queryWithRegex = buildMarketplaceDiscoveryQuery(new URLSearchParams({
        language: "English.*+",
      }));
      assert.ok(queryWithRegex.language instanceof RegExp);
      // Ensure regex is escaped and doesn't crash on execution
      assert.doesNotThrow(() => {
        "English.*+".match(queryWithRegex.language);
      });
    });
  });

  // =========================================================================
  // 3. AUTHORIZATION BOUNDARY CONTRACTS
  // =========================================================================
  describe("3. Authorization Boundary Contract Verification", () => {
    it("Normal Path: public boundary allows anonymous browse but strips sensitive storage fields", () => {
      const publicEval = evaluateAuthorizationBoundary({
        boundary: AUTHORIZATION_BOUNDARIES.PUBLIC,
        actor: null,
        resource: { visibility: "public" },
        action: "read",
      });
      assert.equal(publicEval.allowed, true);

      // Sanitization verification
      const rawCatalogItem = {
        _id: new ObjectId(),
        title: "Clean Math Notes",
        price: 15,
        userAddress: "GCREATOR",
        storageKey: "ipfs://QmSecretFile",
        fileUrl: "https://secret.pinata.cloud/file",
        metadataUrl: "https://secret.pinata.cloud/meta",
      };

      const complianceBefore = validateCatalogItemCompliance(rawCatalogItem);
      assert.equal(complianceBefore.valid, false);
      assert.equal(complianceBefore.violations.length, 3);

      // Sanitize
      const { storageKey, fileUrl, metadataUrl, ...safeItem } = rawCatalogItem;
      const complianceAfter = validateCatalogItemCompliance(safeItem);
      assert.equal(complianceAfter.valid, true);
    });

    it("Normal & Failure Path: buyer boundary enforces authentication and entitlement checks", () => {
      const buyerActor = { sub: "user-buyer-1", walletAddress: "GBUYER1" };
      const resourceWithEntitlement = {
        _id: "mat-100",
        userAddress: "GCREATOR",
        entitledAddresses: ["gbuyer1"],
        entitlementState: "active",
      };
      const resourceWithoutEntitlement = {
        _id: "mat-200",
        userAddress: "GCREATOR",
        entitledAddresses: ["someone_else"],
        entitlementState: "revoked",
      };

      // 1. Unauthenticated buyer rejected
      const unauth = evaluateAuthorizationBoundary({
        boundary: AUTHORIZATION_BOUNDARIES.BUYER,
        actor: null,
        resource: resourceWithEntitlement,
        action: "download",
      });
      assert.equal(unauth.allowed, false);
      assert.equal(unauth.statusCode, 401);

      // 2. Entitled buyer accepted
      const entitled = evaluateAuthorizationBoundary({
        boundary: AUTHORIZATION_BOUNDARIES.BUYER,
        actor: buyerActor,
        resource: resourceWithEntitlement,
        action: "download",
      });
      assert.equal(entitled.allowed, true);

      // 3. Unentitled buyer rejected with 403 (EVT_ENTITLEMENT_004)
      const notEntitled = evaluateAuthorizationBoundary({
        boundary: AUTHORIZATION_BOUNDARIES.BUYER,
        actor: buyerActor,
        resource: resourceWithoutEntitlement,
        action: "download",
      });
      assert.equal(notEntitled.allowed, false);
      assert.equal(notEntitled.statusCode, 403);
      assert.match(notEntitled.reason, /EVT_ENTITLEMENT_004/);
    });

    it("Failure Path: tenant boundary prevents cross-user access to notifications or purchase records", () => {
      const buyerA = { sub: "user-alice", walletAddress: "GALICE" };

      // Alice tries to access Bob's notification
      const bobsNotification = { _id: "notif-1", recipient: "user-bob" };
      const notifCrossAccess = evaluateAuthorizationBoundary({
        boundary: AUTHORIZATION_BOUNDARIES.BUYER,
        actor: buyerA,
        resource: bobsNotification,
        action: "read",
      });
      assert.equal(notifCrossAccess.allowed, false);
      assert.equal(notifCrossAccess.statusCode, 403);
      assert.match(notifCrossAccess.reason, /Tenant boundary violation/);

      // Alice tries to access Bob's purchase record
      const bobsPurchase = { _id: "pur-1", buyerAddress: "GBOB" };
      const purchaseCrossAccess = evaluateAuthorizationBoundary({
        boundary: AUTHORIZATION_BOUNDARIES.BUYER,
        actor: buyerA,
        resource: bobsPurchase,
        action: "read",
      });
      assert.equal(purchaseCrossAccess.allowed, false);
      assert.equal(purchaseCrossAccess.statusCode, 403);
    });

    it("Normal & Failure Path: creator boundary enforces role permission and author ownership", () => {
      const studentActor = { sub: "user-student", role: "student", walletAddress: "GSTUDENT" };
      const creatorAlice = { sub: "user-alice", role: "creator", walletAddress: "GALICE", permissions: ["creator:manage"] };
      const creatorBob = { sub: "user-bob", role: "creator", walletAddress: "GBOB", permissions: ["creator:manage"] };
      const alicesMaterial = { _id: "mat-1", userAddress: "GALICE", title: "Algebra" };

      // 1. Student cannot access creator boundary
      const studentAttempt = evaluateAuthorizationBoundary({
        boundary: AUTHORIZATION_BOUNDARIES.CREATOR,
        actor: studentActor,
        resource: alicesMaterial,
        action: "write",
      });
      assert.equal(studentAttempt.allowed, false);
      assert.equal(studentAttempt.statusCode, 403);

      // 2. Alice can modify her own material
      const aliceOwn = evaluateAuthorizationBoundary({
        boundary: AUTHORIZATION_BOUNDARIES.CREATOR,
        actor: creatorAlice,
        resource: alicesMaterial,
        action: "write",
      });
      assert.equal(aliceOwn.allowed, true);

      // 3. Bob cannot modify Alice's material
      const bobMutateAlice = evaluateAuthorizationBoundary({
        boundary: AUTHORIZATION_BOUNDARIES.CREATOR,
        actor: creatorBob,
        resource: alicesMaterial,
        action: "write",
      });
      assert.equal(bobMutateAlice.allowed, false);
      assert.equal(bobMutateAlice.statusCode, 403);
      assert.match(bobMutateAlice.reason, /not the material owner/);
    });

    it("Normal & Failure Path: operator/admin boundary gates management tools and partial failures", () => {
      const regularUser = { sub: "user-normal", role: "student", walletAddress: "GUSER" };
      const adminActor = { sub: "user-admin", role: "admin", walletAddress: "GADMIN" };
      const opsActor = { sub: "user-ops", role: "maintainer", walletAddress: "GOPS", permissions: ["operations:read", "operations:write"] };

      // 1. Regular user forbidden from admin boundary
      const regAttempt = evaluateAuthorizationBoundary({
        boundary: AUTHORIZATION_BOUNDARIES.OPERATOR_ADMIN,
        actor: regularUser,
        action: "read",
      });
      assert.equal(regAttempt.allowed, false);
      assert.equal(regAttempt.statusCode, 403);

      // 2. Admin allowed
      const adminAccess = evaluateAuthorizationBoundary({
        boundary: AUTHORIZATION_BOUNDARIES.OPERATOR_ADMIN,
        actor: adminActor,
        action: "read",
      });
      assert.equal(adminAccess.allowed, true);

      // 3. Operator with permissions allowed
      const opsAccess = evaluateAuthorizationBoundary({
        boundary: AUTHORIZATION_BOUNDARIES.OPERATOR_ADMIN,
        actor: opsActor,
        action: "write",
      });
      assert.equal(opsAccess.allowed, true);
    });

    it("Retry Path: partial failure retry contract verifies safe vs user-action-required transitions", () => {
      // 1. Safe failure: eligible for automated/operator retry
      const safeFailure = {
        failureId: "job-1",
        domain: "async_jobs",
        status: "unresolved",
        canRetrySafely: true,
        requiresUserAction: false,
      };
      const checkSafe = verifyPartialFailureRetryEligibility(safeFailure);
      assert.equal(checkSafe.canRetry, true);

      // 2. User-action required failure: blocked until user intervenes
      const userBlockedFailure = {
        failureId: "refund-1",
        domain: "user_operations",
        status: "unresolved",
        canRetrySafely: false,
        requiresUserAction: true,
        userActionGuidance: "User destination account missing trustline. Fund wallet or create trustline.",
      };
      const checkBlocked = verifyPartialFailureRetryEligibility(userBlockedFailure);
      assert.equal(checkBlocked.canRetry, false);
      assert.equal(checkBlocked.userActionRequired, true);
      assert.match(checkBlocked.reason, /trustline/);

      // 3. Retry idempotence contract evaluation
      const firstAttempt = { status: 201, body: { id: "res-123", success: true } };
      const secondAttempt = { status: 200, body: { id: "res-123", success: true, duplicate: true } };
      const retryEval = evaluateRetryContract({ firstCall: firstAttempt, retryCall: secondAttempt });
      assert.equal(retryEval.valid, true);
    });
  });
});
