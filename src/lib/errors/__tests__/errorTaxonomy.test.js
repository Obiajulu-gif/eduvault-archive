import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { AppError, toAppError } from "../AppError.js";
import { ERROR_CODES, getErrorCode } from "../codes.js";
import { getCorrelationId } from "../correlation.js";
import { renderUserSafeErrorBody, toUserSafeError } from "../userSafeError.js";
import { renderErrorResponse } from "../renderErrorResponse.js";
import { errorResponse } from "@/lib/utils/errorResponse";
import { ValidationError } from "@/lib/api/validation";

describe("error taxonomy", () => {
  const CONTRACT_CODES = [
    "VALIDATION_FAILED",
    "VALIDATION_FIELD",
    "VALIDATION_FILE_TYPE",
    "VALIDATION_FILE_SIZE",
    "VALIDATION_UPLOAD_TOO_LARGE",
    "VALIDATION_RANGE_TOO_LARGE",
    "AUTH_UNAUTHENTICATED",
    "AUTH_SESSION_EXPIRED",
    "AUTH_FORBIDDEN",
    "AUTH_SUSPENDED",
    "ENTITLEMENT_REQUIRED",
    "ENTITLEMENT_PURCHASE_REQUIRED",
    "ENTITLEMENT_UNAVAILABLE",
    "MATERIAL_ARCHIVED",
    "NOT_FOUND",
    "CONFLICT_DUPLICATE",
    "CONFLICT_IDEMPOTENCY_KEY",
    "CONFLICT_STATE",
    "SETTLEMENT_QUOTE_EXPIRED",
    "SETTLEMENT_INSUFFICIENT_FUNDS",
    "SETTLEMENT_TX_FAILED",
    "SETTLEMENT_TIMEOUT",
    "SETTLEMENT_UNAVAILABLE",
    "PAYOUT_PROFILE_INCOMPLETE",
    "PAYOUT_UNAVAILABLE",
    "STORAGE_UPLOAD_FAILED",
    "STORAGE_NOT_FOUND",
    "STORAGE_UNAVAILABLE",
    "STORAGE_QUARANTINED",
    "RATE_LIMITED",
    "INTERNAL",
  ];
  const CONTRACT_STATUSES = {
    VALIDATION_FAILED: 400,
    VALIDATION_FIELD: 400,
    VALIDATION_FILE_TYPE: 400,
    VALIDATION_FILE_SIZE: 400,
    VALIDATION_UPLOAD_TOO_LARGE: 413,
    VALIDATION_RANGE_TOO_LARGE: 413,
    AUTH_UNAUTHENTICATED: 401,
    AUTH_SESSION_EXPIRED: 401,
    AUTH_FORBIDDEN: 403,
    AUTH_SUSPENDED: 403,
    ENTITLEMENT_REQUIRED: 403,
    ENTITLEMENT_PURCHASE_REQUIRED: 402,
    ENTITLEMENT_UNAVAILABLE: 503,
    MATERIAL_ARCHIVED: 410,
    NOT_FOUND: 404,
    CONFLICT_DUPLICATE: 409,
    CONFLICT_IDEMPOTENCY_KEY: 409,
    CONFLICT_STATE: 409,
    SETTLEMENT_QUOTE_EXPIRED: 409,
    SETTLEMENT_INSUFFICIENT_FUNDS: 402,
    SETTLEMENT_TX_FAILED: 502,
    SETTLEMENT_TIMEOUT: 504,
    SETTLEMENT_UNAVAILABLE: 503,
    PAYOUT_PROFILE_INCOMPLETE: 400,
    PAYOUT_UNAVAILABLE: 503,
    STORAGE_UPLOAD_FAILED: 502,
    STORAGE_NOT_FOUND: 404,
    STORAGE_UNAVAILABLE: 503,
    STORAGE_QUARANTINED: 403,
    RATE_LIMITED: 429,
    INTERNAL: 500,
  };

  it("defines stable codes with status, retryability, and recovery for every known failure mode", () => {
    const requiredFields = ["code", "status", "userMessage", "recovery"];
    for (const [name, definition] of Object.entries(ERROR_CODES)) {
      for (const field of requiredFields) {
        expect(definition[field], `${name}.${field}`).toBeTruthy();
      }
      expect(typeof definition.retryable, `${name}.retryable`).toBe("boolean");
      expect(definition.code).toBe(name);
      expect(definition.status).toBeGreaterThanOrEqual(400);
      expect(definition.status).toBeLessThan(600);
    }
  });

  it("keeps the public code catalog stable unless this contract test is intentionally updated", () => {
    expect(Object.keys(ERROR_CODES)).toEqual(CONTRACT_CODES);
    expect(Object.fromEntries(
      Object.entries(ERROR_CODES).map(([code, definition]) => [code, definition.status])
    )).toEqual(CONTRACT_STATUSES);
    expect(ERROR_CODES.ENTITLEMENT_UNAVAILABLE).toMatchObject({
      status: 503,
      retryable: true,
      userMessage: "Access could not be verified right now.",
      recovery: "Wait briefly and check again. Do not repeat a payment while its status is uncertain.",
    });
    expect(ERROR_CODES.MATERIAL_ARCHIVED.status).toBe(410);
    expect(ERROR_CODES.PAYOUT_UNAVAILABLE.status).toBe(503);
    expect(ERROR_CODES.SETTLEMENT_QUOTE_EXPIRED.status).toBe(409);
  });

  it("keeps both published OpenAPI catalogs aligned with the runtime error codes", () => {
    const specPaths = [
      new URL("../../../../public/openapi.yaml", import.meta.url),
      new URL("../../../../docs/openapi.yaml", import.meta.url),
    ];

    for (const specPath of specPaths) {
      const spec = parse(readFileSync(fileURLToPath(specPath), "utf8"));
      expect(spec.components.schemas.ProblemDetails.properties.code.enum).toEqual(CONTRACT_CODES);
      for (const response of Object.values(spec.components.responses)) {
        expect(response.content["application/problem+json"].schema.$ref)
          .toBe("#/components/schemas/ProblemDetails");
      }
    }
  });

  it("covers validation, authorization, settlement, and internal failure families", () => {
    const codes = Object.keys(ERROR_CODES);
    expect(codes).toContain("VALIDATION_FAILED");
    expect(codes).toContain("AUTH_UNAUTHENTICATED");
    expect(codes).toContain("AUTH_FORBIDDEN");
    expect(codes).toContain("SETTLEMENT_TX_FAILED");
    expect(codes).toContain("SETTLEMENT_INSUFFICIENT_FUNDS");
    expect(codes).toContain("INTERNAL");
  });

  it("falls back to INTERNAL for unknown codes", () => {
    expect(getErrorCode("DOES_NOT_EXIST").code).toBe("INTERNAL");
    expect(getErrorCode("__proto__").code).toBe("INTERNAL");
  });
});

describe("AppError", () => {
  it("carries the code definition metadata", () => {
    const error = new AppError("AUTH_FORBIDDEN", { details: { route: "materials" } });
    expect(error.code).toBe("AUTH_FORBIDDEN");
    expect(error.status).toBe(403);
    expect(error.retryable).toBe(false);
    expect(error.userMessage).toBe(ERROR_CODES.AUTH_FORBIDDEN.userMessage);
    expect(error.recovery).toBeTruthy();
    expect(error.details).toEqual({ route: "materials" });
  });

  it("wraps unknown errors as INTERNAL while preserving the cause", () => {
    const original = new Error("mongo connection refused");
    const wrapped = toAppError(original);
    expect(wrapped.code).toBe("INTERNAL");
    expect(wrapped.status).toBe(500);
    expect(wrapped.retryable).toBe(true);
    expect(wrapped.cause).toBe(original);
  });

  it("passes through existing AppErrors unchanged", () => {
    const original = new AppError("NOT_FOUND");
    expect(toAppError(original)).toBe(original);
  });
});

describe("toUserSafeError", () => {
  it("maps validation errors to generic safe guidance without echoing request data", () => {
    const safe = toUserSafeError(new ValidationError("Invalid price: user supplied value", { field: "price" }));
    expect(safe.code).toBe("VALIDATION_FIELD");
    expect(safe.status).toBe(400);
    expect(safe.retryable).toBe(false);
    expect(safe.userMessage).toBe(ERROR_CODES.VALIDATION_FIELD.userMessage);
    expect(safe.recovery).toBeTruthy();
    expect(safe.details).toEqual({});
  });

  it("maps authorization failures to AUTH_FORBIDDEN", () => {
    const safe = toUserSafeError(new AppError("AUTH_FORBIDDEN"));
    expect(safe.code).toBe("AUTH_FORBIDDEN");
    expect(safe.status).toBe(403);
    expect(safe.userMessage).toBe(ERROR_CODES.AUTH_FORBIDDEN.userMessage);
  });

  it("maps settlement failures to retryable settlement codes", () => {
    const safe = toUserSafeError(new AppError("SETTLEMENT_TX_FAILED"));
    expect(safe.code).toBe("SETTLEMENT_TX_FAILED");
    expect(safe.status).toBe(502);
    expect(safe.retryable).toBe(true);
    expect(safe.recovery).toMatch(/try again/i);
  });

  it("maps MongoDB duplicate key errors to CONFLICT_DUPLICATE", () => {
    const duplicate = new Error("E11000 duplicate key error");
    duplicate.code = 11000;
    const safe = toUserSafeError(duplicate);
    expect(safe.code).toBe("CONFLICT_DUPLICATE");
    expect(safe.status).toBe(409);
  });

  it("maps network timeouts to SETTLEMENT_TIMEOUT", () => {
    const timeout = new Error("socket hang up");
    timeout.code = "ECONNABORTED";
    const safe = toUserSafeError(timeout);
    expect(safe.code).toBe("SETTLEMENT_TIMEOUT");
    expect(safe.retryable).toBe(true);
  });

  it("collapses unexpected errors to INTERNAL without leaking internals", () => {
    const safe = toUserSafeError(new Error("secret internal detail: mongodb://user:pass@host"));
    expect(safe.code).toBe("INTERNAL");
    expect(safe.status).toBe(500);
    expect(safe.userMessage).toBe(ERROR_CODES.INTERNAL.userMessage);
    expect(JSON.stringify(safe)).not.toContain("mongodb://");
    expect(JSON.stringify(safe)).not.toContain("secret internal detail");
  });

  it("handles non-Error thrown values", () => {
    const safe = toUserSafeError("string failure");
    expect(safe.code).toBe("INTERNAL");
    expect(safe.status).toBe(500);
  });
});

describe("renderUserSafeErrorBody", () => {
  it("renders RFC 7807 problem details with a correlation ID", () => {
    const body = renderUserSafeErrorBody(new AppError("VALIDATION_FAILED"), {
      correlationId: "corr-123",
      instance: "/api/materials",
    });
    expect(body.type).toBe("https://eduvault.dev/problems/validation_failed");
    expect(body.status).toBe(400);
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.correlationId).toBe("corr-123");
    expect(body.instance).toBe("/api/materials");
    expect(body.retryable).toBe(false);
  });

  it("never includes internal error messages in the rendered body", () => {
    const body = renderUserSafeErrorBody(new Error("internal stack: at secret.js:12"), {
      correlationId: "corr-456",
    });
    expect(body.code).toBe("INTERNAL");
    expect(body.detail).toBe(ERROR_CODES.INTERNAL.recovery);
    expect(JSON.stringify(body)).not.toContain("secret.js");
  });

  it("returns RFC 9457 JSON with safe fields, a generated correlation id, and no internal details", async () => {
    const request = new Request("https://eduvault.example/api/purchase?token=private");
    const response = renderErrorResponse(new Error("database URI and secret"), { request });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(response.headers.get("x-correlation-id")).toBe(body.correlationId);
    expect(body).toMatchObject({
      type: "https://eduvault.dev/problems/internal",
      status: 500,
      code: "INTERNAL",
      instance: "/api/purchase",
      retryable: true,
    });
    expect(JSON.stringify(body)).not.toContain("private");
    expect(JSON.stringify(body)).not.toContain("database URI");
  });
});

describe("legacy problem response adapter", () => {
  it("adds stable taxonomy fields without removing the existing occurrence detail", async () => {
    const response = errorResponse({
      status: 403,
      detail: "Only the owner can archive this material.",
      request: new Request("https://eduvault.example/api/materials/m1/archive", {
        headers: { "x-correlation-id": "case-42" },
      }),
    });
    const body = await response.json();

    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(body).toMatchObject({
      code: "AUTH_FORBIDDEN",
      status: 403,
      detail: "Only the owner can archive this material.",
      recovery: ERROR_CODES.AUTH_FORBIDDEN.recovery,
      correlationId: "case-42",
    });
  });
});

describe("correlation IDs", () => {
  it("generates a UUID when no header is present", () => {
    const id = getCorrelationId({ headers: new Headers() });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reuses the incoming x-correlation-id header", () => {
    const headers = new Headers();
    headers.set("x-correlation-id", "support-case-42");
    expect(getCorrelationId({ headers })).toBe("support-case-42");
  });

  it("generates a fresh ID when the header is missing or blank", () => {
    expect(getCorrelationId({ headers: new Headers() })).toMatch(/^[0-9a-f-]{36}$/);
    const blank = new Headers();
    blank.set("x-correlation-id", "   ");
    expect(getCorrelationId({ headers: blank })).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects correlation IDs containing unsafe characters or exceeding the length limit", () => {
    const requestWithHeader = (value) => ({ headers: { get: () => value } });
    expect(getCorrelationId(requestWithHeader("case\r\ninjected"))).toMatch(/^[0-9a-f-]{36}$/);
    expect(getCorrelationId(requestWithHeader("a".repeat(65)))).toMatch(/^[0-9a-f-]{36}$/);
  });
});
