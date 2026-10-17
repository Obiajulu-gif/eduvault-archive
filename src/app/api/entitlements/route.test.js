import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const { mockVerifyEntitlement } = vi.hoisted(() => ({
  mockVerifyEntitlement: vi.fn(),
}));

vi.mock("@/lib/entitlement", () => ({
  verifyEntitlement: mockVerifyEntitlement,
}));

describe("GET /api/entitlements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a safe validation problem when required query values are absent", async () => {
    const response = await GET(new Request("http://localhost/api/entitlements"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(body.code).toBe("VALIDATION_FIELD");
    expect(body.error).toBe("Missing buyerAddress or materialId");
    expect(mockVerifyEntitlement).not.toHaveBeenCalled();
  });

  it("returns a retryable safe problem when entitlement verification is unavailable", async () => {
    mockVerifyEntitlement.mockRejectedValue(new Error("database endpoint and credential"));
    const response = await GET(new Request(
      "http://localhost/api/entitlements?buyerAddress=GEXAMPLE&materialId=mat-1"
    ));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.code).toBe("ENTITLEMENT_UNAVAILABLE");
    expect(body.retryable).toBe(true);
    expect(body.correlationId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("credential");
  });
});
