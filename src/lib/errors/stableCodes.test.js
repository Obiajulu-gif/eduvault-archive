import { describe, expect, it } from "vitest";
import { publicError, publicErrorCatalog } from "./stableCodes.js";

describe("stable API error contract", () => {
  it("returns safe recovery guidance for normal and authorization failures", () => {
    expect(publicError("VALIDATION_FAILED")).toMatchObject({ code: "VALIDATION_FAILED", retryable: false });
    expect(publicError("AUTH_FORBIDDEN")).toMatchObject({ status: 403, retryable: false, recovery: expect.any(String) });
  });

  it("preserves retry semantics and exposes a machine-readable catalog", () => {
    expect(publicError("SETTLEMENT_UNAVAILABLE")).toMatchObject({ status: 503, retryable: true });
    const catalog = publicErrorCatalog();
    expect(catalog.length).toBeGreaterThan(10);
    expect(catalog.every((entry) => !("remediationHints" in entry))).toBe(true);
  });
});

