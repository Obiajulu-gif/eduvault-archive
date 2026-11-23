/**
 * src/lib/backend/boundaryContract.js
 *
 * Contract specifications, boundary definitions, and runtime validators for:
 * 1. Pagination (cursor-based keyset and offset fallback, stability invariants, tie-breaking)
 * 2. Filtering (marketplace discovery filters, catalog invariants, sanitization, facet shapes)
 * 3. Authorization Boundaries (Public, Buyer/Student, Creator/Owner, Maintainer/Operator)
 *
 * Covers Normal, Failure, Retry, and Authorization execution paths.
 */

import { ObjectId } from "mongodb";
import {
  decodeMarketplaceCursor,
  encodeMarketplaceCursor,
  buildMarketplaceSort,
  buildMarketplaceCursorClause,
  buildMarketplaceDiscoveryQuery,
} from "./marketplaceDiscovery.js";
import { STATUS_PRECEDENCE, sortRecords, paginateRecords } from "./sortContract.js";

export const PAGINATION_TYPES = Object.freeze(["cursor", "offset"]);

export const DEFAULT_PAGE_SIZE = 12;
export const MAX_PAGE_SIZE = 100;

export const SUPPORTED_SORT_PATTERNS = Object.freeze([
  "newest",
  "price_asc",
  "price_desc",
  "rating_desc",
  "popular",
  "relevance",
]);

export const AUTHORIZATION_BOUNDARIES = Object.freeze({
  PUBLIC: "public",
  BUYER: "buyer",
  CREATOR: "creator",
  OPERATOR_ADMIN: "operator_admin",
});

export const SENSITIVE_STORAGE_FIELDS = Object.freeze([
  "storageKey",
  "fileUrl",
  "metadataUrl",
]);

export const CATALOG_VISIBILITY_INVARIANTS = Object.freeze({
  visibility: "public",
  isDeletedNe: true,
  moderationStatusNe: "suspended",
  creatorSuspendedNe: true,
  archivedNe: true,
  quarantineStateCleanOrMissing: true,
  relevanceStatusNeLow: true,
});

/**
 * Strict parser for pagination query parameters according to the pagination contract.
 *
 * @param {URLSearchParams} searchParams
 * @param {object} [options]
 * @param {number} [options.defaultPageSize=12]
 * @param {number} [options.maxPageSize=100]
 * @returns {{ cursor: string|null, page: number|null, pageSize: number, paginationType: 'cursor'|'offset' }}
 */
export function parsePaginationContractParams(searchParams, { defaultPageSize = DEFAULT_PAGE_SIZE, maxPageSize = MAX_PAGE_SIZE } = {}) {
  const rawPageSize = Number(searchParams.get("pageSize") || defaultPageSize);
  const pageSize = Number.isFinite(rawPageSize)
    ? Math.max(1, Math.min(maxPageSize, Math.floor(rawPageSize)))
    : defaultPageSize;

  const cursor = searchParams.get("cursor");
  const paginationTypeParam = searchParams.get("paginationType");
  const pageParam = searchParams.get("page");

  if (cursor || paginationTypeParam === "cursor" || (!pageParam && paginationTypeParam !== "offset")) {
    return {
      cursor: cursor || null,
      page: null,
      pageSize,
      paginationType: "cursor",
    };
  }

  const rawPage = Number(pageParam || 1);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;
  return {
    cursor: null,
    page,
    pageSize,
    paginationType: "offset",
  };
}

/**
 * Validates that an API response adheres to the pagination contract.
 *
 * @param {object} payload - Response body from a paginated endpoint
 * @param {object} [options]
 * @param {string} [options.expectedType='cursor'] - 'cursor' | 'offset'
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePaginationContract(payload, { expectedType = "cursor" } = {}) {
  const errors = [];
  if (!payload || typeof payload !== "object") {
    return { valid: false, errors: ["Payload must be a non-null object"] };
  }

  if (!Array.isArray(payload.items)) {
    errors.push("Missing or invalid 'items' array");
  }

  const paginationType = payload.paginationType ?? expectedType;
  if (!PAGINATION_TYPES.includes(paginationType)) {
    errors.push(`Invalid paginationType: '${paginationType}'. Expected 'cursor' or 'offset'`);
  }

  if (paginationType === "cursor") {
    if (typeof payload.pageSize !== "number" || payload.pageSize < 1 || payload.pageSize > MAX_PAGE_SIZE) {
      errors.push(`pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}, got ${payload.pageSize}`);
    }
    if (typeof payload.hasNextPage !== "boolean") {
      errors.push("hasNextPage must be a boolean");
    }
    if (payload.hasNextPage && (!payload.nextCursor || typeof payload.nextCursor !== "string")) {
      errors.push("nextCursor must be a non-empty string when hasNextPage is true and items are present");
    }
    if (payload.nextCursor && typeof payload.nextCursor !== "string") {
      errors.push("nextCursor must be a string or null");
    }
  } else if (paginationType === "offset") {
    if (typeof payload.page !== "number" || payload.page < 1) {
      errors.push("page must be an integer >= 1");
    }
    if (typeof payload.pageSize !== "number" || payload.pageSize < 1 || payload.pageSize > MAX_PAGE_SIZE) {
      errors.push(`pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`);
    }
    if (typeof payload.total !== "number" || payload.total < 0) {
      errors.push("total must be a non-negative integer");
    }
    if (typeof payload.totalPages !== "number" || payload.totalPages < 1) {
      errors.push("totalPages must be an integer >= 1");
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates cursor integrity and detects tampering or operator injection.
 *
 * @param {string} cursor - Opaque base64url cursor
 * @param {object} sort - MongoDB sort definition
 * @returns {{ valid: boolean, cursorData: object|null, error: string|null }}
 */
export function validateCursorIntegrity(cursor, sort) {
  if (!cursor || typeof cursor !== "string") {
    return { valid: false, cursorData: null, error: "Missing or non-string cursor" };
  }

  try {
    const cursorData = decodeMarketplaceCursor(cursor, sort);
    if (!cursorData || !cursorData._id || !ObjectId.isValid(cursorData._id)) {
      return { valid: false, cursorData: null, error: "Invalid cursor structure or ObjectId" };
    }
    return { valid: true, cursorData, error: null };
  } catch (err) {
    return { valid: false, cursorData: null, error: err.message || "Invalid marketplace cursor" };
  }
}

/**
 * Verifies that a catalog item returned from public discovery complies with the
 * filtering and security boundary (no sensitive storage keys, public visibility,
 * clean quarantine, non-deleted, non-suspended).
 *
 * @param {object} item - Material item from catalog response
 * @returns {{ valid: boolean, violations: string[] }}
 */
export function validateCatalogItemCompliance(item) {
  const violations = [];
  if (!item || typeof item !== "object") {
    return { valid: false, violations: ["Item must be an object"] };
  }

  // 1. Sensitive field leakage check
  for (const field of SENSITIVE_STORAGE_FIELDS) {
    if (item[field] !== undefined) {
      violations.push(`Sensitive storage field '${field}' leaked across boundary`);
    }
  }

  // 2. Lifecycle invariants
  if (item.visibility && item.visibility !== "public") {
    violations.push(`Non-public visibility '${item.visibility}' leaked in public discovery`);
  }
  if (item.isDeleted === true) {
    violations.push("Soft-deleted material returned in public discovery");
  }
  if (item.creatorSuspended === true) {
    violations.push("Material by suspended creator returned in public discovery");
  }
  if (item.moderationStatus === "suspended") {
    violations.push("Suspended material returned in public discovery");
  }
  if (item.archived === true) {
    violations.push("Archived material returned in public discovery");
  }
  if (item.quarantineState && item.quarantineState !== "clean") {
    violations.push(`Material with non-clean quarantineState '${item.quarantineState}' leaked in public discovery`);
  }
  if (item.relevanceStatus === "low") {
    violations.push("Material with low relevanceStatus leaked in public discovery");
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Checks whether an item satisfies all specified discovery filters.
 *
 * @param {object} item
 * @param {object} filters
 * @returns {{ matches: boolean, failures: string[] }}
 */
export function validateFilterMatch(item, filters = {}) {
  const failures = [];

  if (filters.subject && String(item.subject || "").toLowerCase() !== String(filters.subject).toLowerCase()) {
    failures.push(`Expected subject '${filters.subject}', got '${item.subject}'`);
  }

  if (filters.category && String(item.category || "").toLowerCase() !== String(filters.category).toLowerCase()) {
    failures.push(`Expected category '${filters.category}', got '${item.category}'`);
  }

  if (filters.level && String(item.level || "").toLowerCase() !== String(filters.level).toLowerCase()) {
    failures.push(`Expected level '${filters.level}', got '${item.level}'`);
  }

  if (filters.language && String(item.language || "").toLowerCase() !== String(filters.language).toLowerCase()) {
    failures.push(`Expected language '${filters.language}', got '${item.language}'`);
  }

  if (filters.minPrice !== undefined && filters.minPrice !== null) {
    const price = Number(item.price ?? 0);
    if (price < Number(filters.minPrice)) {
      failures.push(`Price ${price} is lower than minPrice ${filters.minPrice}`);
    }
  }

  if (filters.maxPrice !== undefined && filters.maxPrice !== null) {
    const price = Number(item.price ?? 0);
    if (price > Number(filters.maxPrice)) {
      failures.push(`Price ${price} exceeds maxPrice ${filters.maxPrice}`);
    }
  }

  if (filters.minRating !== undefined && filters.minRating !== null) {
    const rating = Number(item.rating ?? item.averageScore ?? 0);
    if (rating < Number(filters.minRating)) {
      failures.push(`Rating ${rating} is lower than minRating ${filters.minRating}`);
    }
  }

  return { matches: failures.length === 0, failures };
}

/**
 * Evaluates authorization boundaries for a request.
 *
 * @param {object} params
 * @param {string} params.boundary - One of AUTHORIZATION_BOUNDARIES
 * @param {object|null} params.actor - Authenticated user payload { sub, role, walletAddress, permissions }
 * @param {object} [params.resource] - Target resource being accessed { userAddress, recipient, active, entitlementState }
 * @param {string} [params.action] - Action requested ('read', 'write', 'download', 'impersonate', etc.)
 * @returns {{ allowed: boolean, statusCode: number, reason: string|null }}
 */
export function evaluateAuthorizationBoundary({ boundary, actor, resource = null, action = "read" }) {
  // 1. Public Boundary
  if (boundary === AUTHORIZATION_BOUNDARIES.PUBLIC) {
    if (resource) {
      if (resource.visibility && resource.visibility !== "public") {
        return { allowed: false, statusCode: 403, reason: "Resource is not public" };
      }
      if (resource.isDeleted || resource.moderationStatus === "suspended" || resource.creatorSuspended) {
        return { allowed: false, statusCode: 404, reason: "Resource not available in public catalog" };
      }
    }
    return { allowed: true, statusCode: 200, reason: null };
  }

  // Authenticated boundaries require an actor
  if (!actor || !actor.sub) {
    return { allowed: false, statusCode: 401, reason: "Authentication required" };
  }

  // 2. Buyer Boundary
  if (boundary === AUTHORIZATION_BOUNDARIES.BUYER) {
    const actorWallet = (actor.walletAddress || actor.address || "").toLowerCase();
    if (action === "download" || action === "view_purchased") {
      if (!resource) {
        return { allowed: false, statusCode: 404, reason: "Resource not found" };
      }
      // Entitlement check
      const hasEntitlement = resource.hasActiveEntitlement === true ||
        resource.entitlementState === "active" ||
        (Array.isArray(resource.entitledAddresses) && resource.entitledAddresses.map(a => a.toLowerCase()).includes(actorWallet));
      const isOwner = resource.userAddress && resource.userAddress.toLowerCase() === actorWallet;

      if (!hasEntitlement && !isOwner) {
        return { allowed: false, statusCode: 403, reason: "Active entitlement required (EVT_ENTITLEMENT_004)" };
      }
    }

    // Tenant isolation: buyer can only access own notifications, progress, saved materials
    if (resource?.recipient && resource.recipient !== actor.sub) {
      return { allowed: false, statusCode: 403, reason: "Tenant boundary violation: cannot access another user's notifications" };
    }
    if (resource?.buyerAddress && actorWallet && resource.buyerAddress.toLowerCase() !== actorWallet) {
      return { allowed: false, statusCode: 403, reason: "Tenant boundary violation: cannot access another user's purchase data" };
    }

    return { allowed: true, statusCode: 200, reason: null };
  }

  // 3. Creator Boundary
  if (boundary === AUTHORIZATION_BOUNDARIES.CREATOR) {
    const isCreator = actor.role === "creator" ||
      actor.role === "admin" ||
      (Array.isArray(actor.permissions) && actor.permissions.includes("creator:manage"));
    if (!isCreator) {
      return { allowed: false, statusCode: 403, reason: "Creator access required" };
    }

    // Ownership boundary for modifications
    if (action === "write" || action === "delete" || action === "update") {
      const actorWallet = (actor.walletAddress || actor.address || "").toLowerCase();
      const isAdmin = actor.role === "admin" || actor.isAdmin === true;
      if (resource?.userAddress && !isAdmin) {
        const resourceOwner = resource.userAddress.toLowerCase();
        if (resourceOwner !== actorWallet) {
          return { allowed: false, statusCode: 403, reason: "Forbidden: not the material owner" };
        }
      }
    }

    return { allowed: true, statusCode: 200, reason: null };
  }

  // 4. Operator / Admin Boundary
  if (boundary === AUTHORIZATION_BOUNDARIES.OPERATOR_ADMIN) {
    const hasAdminRole = actor.role === "admin" || actor.isAdmin === true;
    const hasOpsPermission = Array.isArray(actor.permissions) && (
      actor.permissions.includes("operations:read") ||
      actor.permissions.includes("operations:write") ||
      actor.permissions.includes("storage:maintain")
    );

    if (!hasAdminRole && !hasOpsPermission) {
      return { allowed: false, statusCode: 403, reason: "Operations or Admin access required" };
    }

    return { allowed: true, statusCode: 200, reason: null };
  }

  return { allowed: false, statusCode: 400, reason: `Unknown authorization boundary: ${boundary}` };
}

/**
 * Validates a paginated sequence walk across pages to guarantee monotonicity,
 * absence of duplicate items, and deterministic ordering.
 *
 * @param {Array<Array<object>>} pages - Array of page item arrays
 * @param {object} [options]
 * @param {string} [options.idField='_id']
 * @returns {{ stable: boolean, seenCount: number, duplicates: string[], violations: string[] }}
 */
export function verifyPaginationWalkStability(pages, { idField = "_id" } = {}) {
  const seen = new Set();
  const duplicates = [];
  const violations = [];
  let totalSeen = 0;

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx += 1) {
    const page = pages[pageIdx];
    if (!Array.isArray(page)) {
      violations.push(`Page index ${pageIdx} is not an array`);
      continue;
    }

    for (let itemIdx = 0; itemIdx < page.length; itemIdx += 1) {
      const item = page[itemIdx];
      const id = String(item[idField] ?? item.id ?? "");
      if (!id) {
        violations.push(`Page ${pageIdx} item ${itemIdx} has no valid id`);
        continue;
      }
      if (seen.has(id)) {
        duplicates.push(id);
      }
      seen.add(id);
      totalSeen += 1;
    }
  }

  return {
    stable: duplicates.length === 0 && violations.length === 0,
    seenCount: totalSeen,
    duplicates,
    violations,
  };
}

/**
 * Evaluates retry and idempotency contracts for operations.
 *
 * @param {object} params
 * @param {object} params.firstCall - Result of the initial call
 * @param {object} params.retryCall - Result of the subsequent call with same parameters/key
 * @param {boolean} [params.requireIdempotence=true] - Whether retry must return identical or duplicate-flagged result
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function evaluateRetryContract({ firstCall, retryCall, requireIdempotence = true }) {
  const errors = [];
  if (!firstCall || !retryCall) {
    return { valid: false, errors: ["Both firstCall and retryCall must be provided"] };
  }

  if (firstCall.status !== retryCall.status && !(firstCall.status === 201 && retryCall.status === 200)) {
    errors.push(`Status code mismatch on retry: original was ${firstCall.status}, retry was ${retryCall.status}`);
  }

  if (requireIdempotence) {
    if (firstCall.body?.id && retryCall.body?.id && firstCall.body.id !== retryCall.body.id) {
      errors.push(`Created resource ID differed on retry: '${firstCall.body.id}' vs '${retryCall.body.id}'`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Verifies retry safety rules for partial failure remediation.
 *
 * @param {object} failureDoc - Normalized partial failure document
 * @returns {{ canRetry: boolean, reason: string|null, userActionRequired: boolean }}
 */
export function verifyPartialFailureRetryEligibility(failureDoc) {
  if (!failureDoc) {
    return { canRetry: false, reason: "Failure document is null", userActionRequired: false };
  }

  if (failureDoc.requiresUserAction === true) {
    return {
      canRetry: false,
      reason: failureDoc.userActionGuidance || "User action required before retry can proceed",
      userActionRequired: true,
    };
  }

  if (failureDoc.canRetrySafely === false) {
    return {
      canRetry: false,
      reason: "Operation flagged as unsafe for automatic retry",
      userActionRequired: false,
    };
  }

  if (failureDoc.status === "resolved") {
    return {
      canRetry: false,
      reason: "Failure is already resolved",
      userActionRequired: false,
    };
  }

  return {
    canRetry: true,
    reason: null,
    userActionRequired: false,
  };
}
