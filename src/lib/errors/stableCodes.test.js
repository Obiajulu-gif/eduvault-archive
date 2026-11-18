import { describe, expect, it } from "vitest";
import {
  StableErrorAuthorizationError,
  getOperatorRemediation,
  publicError,
  publicErrorCatalog,
  resolveStableError,
  validateStableErrorCatalog,
} from "./stableCodes.js";

describe("stable API error contract (#1076)", () => {
  it("returns safe recovery guidance for normal and authorization failures", () => {
    expect(publicError("VALIDATION_FAILED")).toMatchObject({ code: "VALIDATION_FAILED", retryable: false });
    expect(publicError("AUTH_FORBIDDEN")).toMatchObject({ status: 403, retryable: false, recovery: expect.any(String) });
  });

  it("preserves retry semantics and exposes a machine-readable catalog without internal hints", () => {
    expect(publicError("SETTLEMENT_UNAVAILABLE")).toMatchObject({ status: 503, retryable: true });
    const catalog = publicErrorCatalog();
    expect(catalog.length).toBeGreaterThan(10);
    expect(catalog.every((entry) => !("remediationHints" in entry))).toBe(true);
    expect(validateStableErrorCatalog()).toEqual({ valid: true, count: catalog.length, violations: [] });
  });

  it("falls back safely to INTERNAL for unknown errors without leaking raw messages", () => {
    const resolved = resolveStableError(new Error("db password=secret failed"), { correlationId: "corr-123" });
    expect(resolved.code).toBe("INTERNAL");
    expect(resolved.status).toBe(500);
    expect(resolved.retryable).toBe(false);
    expect(resolved.message).not.toContain("secret");
    expect(resolved.correlationId).toBe("corr-123");

    const retryable = resolveStableError(Object.assign(new Error("timeout"), { code: "SETTLEMENT_TIMEOUT" }));
    expect(retryable).toMatchObject({ code: "SETTLEMENT_TIMEOUT", status: 504, retryable: true });
  });

  it("enforces authentication and operations:read authorization for operator remediation hints", async () => {
    await expect(getOperatorRemediation("SETTLEMENT_UNAVAILABLE", { actor: null }))
      .rejects.toMatchObject({ name: "StableErrorAuthorizationError", status: 401, code: "AUTH_UNAUTHENTICATED" });

    await expect(getOperatorRemediation("SETTLEMENT_UNAVAILABLE", { actor: { id: "u1", role: "learner" } }))
      .rejects.toBeInstanceOf(StableErrorAuthorizationError);

    const adminHints = await getOperatorRemediation("SETTLEMENT_UNAVAILABLE", {
      actor: { id: "a1", role: "admin" },
    });
    expect(adminHints.code).toBe("SETTLEMENT_UNAVAILABLE");
    expect(adminHints.remediationHints.length).toBeGreaterThan(0);

    const serviceHints = await getOperatorRemediation("RATE_LIMITED", {
      actor: { id: "svc1", role: "service" },
    });
    expect(serviceHints.retryable).toBe(true);
    expect(serviceHints.remediationHints.length).toBeGreaterThan(0);
  });
});

