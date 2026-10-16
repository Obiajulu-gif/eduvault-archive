import { describe, expect, it } from "vitest";
import { AppError, toAppError } from "../AppError.js";
import { ERROR_CODES, getErrorCode } from "../codes.js";
import { getCorrelationId } from "../correlation.js";
import { renderUserSafeErrorBody, toUserSafeError } from "../userSafeError.js";
import { ValidationError } from "@/lib/api/validation";

describe("error taxonomy", () => {
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
  it("maps validation errors to VALIDATION_FIELD with field details", () => {
    const safe = toUserSafeError(new ValidationError("Invalid price", { field: "price" }));
    expect(safe.code).toBe("VALIDATION_FIELD");
    expect(safe.status).toBe(400);
    expect(safe.retryable).toBe(false);
    expect(safe.userMessage).toBe("Invalid price");
    expect(safe.recovery).toBeTruthy();
    expect(safe.details).toEqual({ field: "price" });
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
});
