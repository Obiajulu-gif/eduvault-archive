/**
 * Tests for the extended stable error codes and remediation hints (#1012).
 *
 * Tests the taxonomy completeness contract, new codes and families, the
 * remediationHints field, and the updated toUserSafeError mappings.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ERROR_CODES,
  getErrorCode,
  isKnownErrorCode,
  getErrorCodesByFamily,
  getRemediationHints,
} from "../../src/lib/errors/codes.js";

import { AppError, toAppError } from "../../src/lib/errors/AppError.js";
import { toUserSafeError, renderUserSafeErrorBody } from "../../src/lib/errors/userSafeError.js";

// ---------------------------------------------------------------------------
// Taxonomy completeness contract
// ---------------------------------------------------------------------------

describe("ERROR_CODES taxonomy", () => {
  const REQUIRED_FIELDS = ["code", "status", "retryable", "userMessage", "recovery", "remediationHints"];

  test("every code has all required fields", () => {
    for (const [name, def] of Object.entries(ERROR_CODES)) {
      for (const field of REQUIRED_FIELDS) {
        assert.ok(
          def[field] !== undefined && def[field] !== null && def[field] !== "",
          `${name}.${field} is missing or empty`
        );
      }
    }
  });

  test("code field matches the object key", () => {
    for (const [name, def] of Object.entries(ERROR_CODES)) {
      assert.equal(def.code, name, `${name}: code field must equal the key`);
    }
  });

  test("status is a valid HTTP error code (4xx or 5xx)", () => {
    for (const [name, def] of Object.entries(ERROR_CODES)) {
      assert.ok(def.status >= 400 && def.status < 600, `${name}: status ${def.status} is not a 4xx/5xx code`);
    }
  });

  test("retryable is a boolean", () => {
    for (const [name, def] of Object.entries(ERROR_CODES)) {
      assert.equal(typeof def.retryable, "boolean", `${name}.retryable must be boolean`);
    }
  });

  test("remediationHints is a non-empty array of strings for every code", () => {
    for (const [name, def] of Object.entries(ERROR_CODES)) {
      assert.ok(Array.isArray(def.remediationHints),      `${name}.remediationHints must be an array`);
      assert.ok(def.remediationHints.length > 0,          `${name}.remediationHints must not be empty`);
      for (const hint of def.remediationHints) {
        assert.equal(typeof hint, "string", `${name}: each hint must be a string`);
        assert.ok(hint.length > 0,          `${name}: hints must not be empty strings`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Specific family coverage
// ---------------------------------------------------------------------------

describe("ERROR_CODES family coverage", () => {
  test("covers validation family", () => {
    for (const code of ["VALIDATION_FAILED", "VALIDATION_FIELD", "VALIDATION_FILE_TYPE", "VALIDATION_FILE_SIZE", "VALIDATION_MISSING_FIELD", "VALIDATION_PAYLOAD_TOO_LARGE"]) {
      assert.ok(ERROR_CODES[code], `Missing validation code: ${code}`);
      assert.equal(Math.floor(ERROR_CODES[code].status / 100), 4);
    }
  });

  test("covers auth family", () => {
    for (const code of ["AUTH_UNAUTHENTICATED", "AUTH_SESSION_EXPIRED", "AUTH_TOKEN_REVOKED", "AUTH_FORBIDDEN", "AUTH_SUSPENDED", "AUTH_WALLET_MISMATCH"]) {
      assert.ok(ERROR_CODES[code], `Missing auth code: ${code}`);
    }
  });

  test("covers not-found family", () => {
    for (const code of ["NOT_FOUND", "NOT_FOUND_MATERIAL", "NOT_FOUND_PURCHASE"]) {
      assert.ok(ERROR_CODES[code], `Missing not-found code: ${code}`);
      assert.equal(ERROR_CODES[code].status, 404);
    }
  });

  test("covers conflict family", () => {
    for (const code of ["CONFLICT_DUPLICATE", "CONFLICT_IN_PROGRESS", "CONFLICT_IDEMPOTENCY_KEY", "CONFLICT_STATE", "CONFLICT_VERSION"]) {
      assert.ok(ERROR_CODES[code], `Missing conflict code: ${code}`);
    }
  });

  test("covers entitlement family", () => {
    for (const code of ["ENTITLEMENT_NOT_FOUND", "ENTITLEMENT_REVOKED", "ENTITLEMENT_EXPIRED"]) {
      assert.ok(ERROR_CODES[code], `Missing entitlement code: ${code}`);
      assert.equal(ERROR_CODES[code].status, 403);
    }
  });

  test("covers settlement family", () => {
    for (const code of ["SETTLEMENT_INSUFFICIENT_FUNDS", "SETTLEMENT_TX_FAILED", "SETTLEMENT_TIMEOUT", "SETTLEMENT_UNAVAILABLE", "SETTLEMENT_QUOTE_EXPIRED", "SETTLEMENT_REFUND_WINDOW_CLOSED"]) {
      assert.ok(ERROR_CODES[code], `Missing settlement code: ${code}`);
    }
  });

  test("covers storage family", () => {
    for (const code of ["STORAGE_UPLOAD_FAILED", "STORAGE_NOT_FOUND", "STORAGE_QUARANTINED", "STORAGE_DOWNLOAD_CAPABILITY_INVALID"]) {
      assert.ok(ERROR_CODES[code], `Missing storage code: ${code}`);
    }
  });

  test("covers blockchain family", () => {
    for (const code of ["BLOCKCHAIN_RPC_UNAVAILABLE", "BLOCKCHAIN_BAD_SEQUENCE", "BLOCKCHAIN_TRUSTLINE_MISSING"]) {
      assert.ok(ERROR_CODES[code], `Missing blockchain code: ${code}`);
    }
  });

  test("covers rate-limiting family", () => {
    for (const code of ["RATE_LIMITED", "RATE_LIMITED_UPLOAD"]) {
      assert.ok(ERROR_CODES[code], `Missing rate-limit code: ${code}`);
      assert.equal(ERROR_CODES[code].status, 429);
      assert.equal(ERROR_CODES[code].retryable, true);
    }
  });

  test("covers content / publishing family", () => {
    for (const code of ["CONTENT_PUBLISHING_FAILED", "CONTENT_DUPLICATE_DETECTED"]) {
      assert.ok(ERROR_CODES[code], `Missing content code: ${code}`);
    }
  });

  test("covers export family", () => {
    for (const code of ["EXPORT_IN_PROGRESS", "EXPORT_NOT_READY"]) {
      assert.ok(ERROR_CODES[code], `Missing export code: ${code}`);
    }
  });

  test("covers internal / service family", () => {
    for (const code of ["INTERNAL", "SERVICE_UNAVAILABLE"]) {
      assert.ok(ERROR_CODES[code], `Missing internal code: ${code}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

describe("getErrorCode", () => {
  test("returns the matching definition for a known code", () => {
    const def = getErrorCode("AUTH_FORBIDDEN");
    assert.equal(def.code,   "AUTH_FORBIDDEN");
    assert.equal(def.status, 403);
  });

  test("falls back to INTERNAL for an unknown code", () => {
    assert.equal(getErrorCode("DOES_NOT_EXIST").code, "INTERNAL");
    assert.equal(getErrorCode("").code,               "INTERNAL");
    assert.equal(getErrorCode(undefined).code,        "INTERNAL");
    assert.equal(getErrorCode(null).code,             "INTERNAL");
  });
});

describe("isKnownErrorCode", () => {
  test("returns true for every registered code", () => {
    for (const code of Object.keys(ERROR_CODES)) {
      assert.equal(isKnownErrorCode(code), true, `Expected isKnownErrorCode(${code}) = true`);
    }
  });

  test("returns false for unknown codes", () => {
    assert.equal(isKnownErrorCode("DOES_NOT_EXIST"), false);
    assert.equal(isKnownErrorCode(""),               false);
    assert.equal(isKnownErrorCode(null),             false);
  });
});

describe("getErrorCodesByFamily", () => {
  test("returns only 4xx codes for family 400", () => {
    const codes = getErrorCodesByFamily(400);
    assert.ok(codes.length > 0);
    for (const def of codes) {
      assert.ok(def.status >= 400 && def.status < 500, `${def.code} is not 4xx`);
    }
  });

  test("returns only 5xx codes for family 500", () => {
    const codes = getErrorCodesByFamily(500);
    assert.ok(codes.length > 0);
    for (const def of codes) {
      assert.ok(def.status >= 500 && def.status < 600, `${def.code} is not 5xx`);
    }
  });

  test("INTERNAL is in the 5xx family", () => {
    const fivexx = getErrorCodesByFamily(500).map((d) => d.code);
    assert.ok(fivexx.includes("INTERNAL"));
  });
});

describe("getRemediationHints", () => {
  test("returns hints array for a known code", () => {
    const hints = getRemediationHints("AUTH_FORBIDDEN");
    assert.ok(Array.isArray(hints));
    assert.ok(hints.length > 0);
    assert.equal(typeof hints[0], "string");
  });

  test("returns empty array for an unknown code", () => {
    assert.deepEqual(getRemediationHints("DOES_NOT_EXIST"), []);
    assert.deepEqual(getRemediationHints(null),             []);
    assert.deepEqual(getRemediationHints(undefined),        []);
  });

  test("hints are not exposed in the RFC 7807 response body", () => {
    const body = renderUserSafeErrorBody(new AppError("AUTH_FORBIDDEN"), { correlationId: "c-1" });
    const serialized = JSON.stringify(body);
    // remediationHints contain developer detail that must not reach clients
    const hints = getRemediationHints("AUTH_FORBIDDEN");
    for (const hint of hints) {
      assert.ok(!serialized.includes(hint), `Remediation hint leaked into response: ${hint.slice(0, 60)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// AppError with new codes
// ---------------------------------------------------------------------------

describe("AppError with new codes", () => {
  test("ENTITLEMENT_NOT_FOUND code properties", () => {
    const err = new AppError("ENTITLEMENT_NOT_FOUND");
    assert.equal(err.code,     "ENTITLEMENT_NOT_FOUND");
    assert.equal(err.status,   403);
    assert.equal(err.retryable, false);
    assert.ok(err.recovery.length > 0);
  });

  test("BLOCKCHAIN_BAD_SEQUENCE is retryable", () => {
    const err = new AppError("BLOCKCHAIN_BAD_SEQUENCE");
    assert.equal(err.retryable, true);
    assert.equal(err.status,    409);
  });

  test("SETTLEMENT_QUOTE_EXPIRED returns 410", () => {
    const err = new AppError("SETTLEMENT_QUOTE_EXPIRED");
    assert.equal(err.status, 410);
    assert.equal(err.retryable, false);
  });

  test("CONFLICT_VERSION returns 409 non-retryable", () => {
    const err = new AppError("CONFLICT_VERSION");
    assert.equal(err.status,    409);
    assert.equal(err.retryable, false);
  });

  test("AUTH_TOKEN_REVOKED returns 401 non-retryable", () => {
    const err = new AppError("AUTH_TOKEN_REVOKED");
    assert.equal(err.status,    401);
    assert.equal(err.retryable, false);
  });
});

// ---------------------------------------------------------------------------
// toUserSafeError — new error pattern mappings
// ---------------------------------------------------------------------------

describe("toUserSafeError — new mappings", () => {
  test("maps session-revocation errors to AUTH_TOKEN_REVOKED", () => {
    const revoked = new Error("session revoked due to replay");
    revoked.code  = "SESSION_REVOKED";
    const safe    = toUserSafeError(revoked);
    assert.equal(safe.code,   "AUTH_TOKEN_REVOKED");
    assert.equal(safe.status, 401);
  });

  test("maps token-reuse detection to AUTH_TOKEN_REVOKED", () => {
    const reuse  = new Error("Token replay detected");
    reuse.code   = "TOKEN_REUSE_DETECTED";
    const safe   = toUserSafeError(reuse);
    assert.equal(safe.code, "AUTH_TOKEN_REVOKED");
  });

  test("maps entitlement-not-found errors to ENTITLEMENT_NOT_FOUND", () => {
    const err  = new Error("entitlement record not found for buyer");
    const safe = toUserSafeError(err);
    assert.equal(safe.code,   "ENTITLEMENT_NOT_FOUND");
    assert.equal(safe.status, 403);
  });

  test("maps tx_bad_seq to BLOCKCHAIN_BAD_SEQUENCE", () => {
    const err  = new Error("Stellar error: tx_bad_seq");
    const safe = toUserSafeError(err);
    assert.equal(safe.code,     "BLOCKCHAIN_BAD_SEQUENCE");
    assert.equal(safe.retryable, true);
  });

  test("maps op_no_trust to BLOCKCHAIN_TRUSTLINE_MISSING", () => {
    const err  = new Error("transaction failed: op_no_trust");
    const safe = toUserSafeError(err);
    assert.equal(safe.code,     "BLOCKCHAIN_TRUSTLINE_MISSING");
    assert.equal(safe.retryable, false);
  });

  test("maps quote_expired to SETTLEMENT_QUOTE_EXPIRED", () => {
    const err  = new Error("quote expired");
    const safe = toUserSafeError(err);
    assert.equal(safe.code,   "SETTLEMENT_QUOTE_EXPIRED");
    assert.equal(safe.status, 410);
  });

  test("AppError with new code passes through unchanged", () => {
    const err  = new AppError("ENTITLEMENT_REVOKED");
    const safe = toUserSafeError(err);
    assert.equal(safe.code,   "ENTITLEMENT_REVOKED");
    assert.equal(safe.status, 403);
  });

  test("unknown errors still collapse to INTERNAL without leaking internals", () => {
    const err  = new Error("secret db password: hunter2");
    const safe = toUserSafeError(err);
    assert.equal(safe.code,   "INTERNAL");
    assert.equal(safe.status, 500);
    assert.ok(!JSON.stringify(safe).includes("hunter2"), "Internal detail leaked");
  });
});

// ---------------------------------------------------------------------------
// renderUserSafeErrorBody — remediationHints must never appear in output
// ---------------------------------------------------------------------------

describe("renderUserSafeErrorBody — no internal leakage", () => {
  test("body does not contain remediationHints for any code", () => {
    for (const [code, def] of Object.entries(ERROR_CODES)) {
      const body       = renderUserSafeErrorBody(new AppError(code));
      const serialized = JSON.stringify(body);
      assert.ok(
        !serialized.includes("remediationHints"),
        `remediationHints key leaked into response for ${code}`
      );
      for (const hint of def.remediationHints) {
        assert.ok(
          !serialized.includes(hint.slice(0, 30)),
          `Hint content leaked for ${code}: ${hint.slice(0, 60)}`
        );
      }
    }
  });

  test("RFC 7807 type URL uses the lowercased code", () => {
    const body = renderUserSafeErrorBody(new AppError("ENTITLEMENT_NOT_FOUND"));
    assert.equal(body.type, "https://eduvault.dev/problems/entitlement_not_found");
  });
});
