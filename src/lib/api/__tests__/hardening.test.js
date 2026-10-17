import { beforeEach, describe, expect, it, vi } from "vitest";
import { withApiHardening } from "../hardening";
import { ValidationError } from "../validation";

const { mockAuditLog, mockRateLimit, mockClientKey, mockCaptureException } = vi.hoisted(() => ({
  mockAuditLog: vi.fn(),
  mockRateLimit: vi.fn(),
  mockClientKey: vi.fn(),
  mockCaptureException: vi.fn(),
}));

vi.mock("../audit", () => ({ auditLog: mockAuditLog }));
vi.mock("../rateLimit", () => ({ slidingWindowRateLimit: mockRateLimit }));
vi.mock("../clientKey.mjs", () => ({ clientKey: mockClientKey }));
vi.mock("@/lib/sentry", () => ({ captureException: mockCaptureException }));

describe("withApiHardening error contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: 0 });
    mockClientKey.mockReturnValue("client");
  });

  it("returns a retry-after problem response when the caller is rate limited", async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfter: 15 });
    const response = await withApiHardening(
      new Request("http://localhost/api/example"),
      { route: "example" },
      async () => new Response("unexpected")
    );
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(response.headers.get("retry-after")).toBe("15");
    expect(body).toMatchObject({ code: "RATE_LIMITED", retryable: true, retryAfter: 15 });
  });

  it("normalizes thrown validation errors without reflecting their message", async () => {
    const response = await withApiHardening(
      new Request("http://localhost/api/example"),
      { route: "example" },
      async () => {
        throw new ValidationError("untrusted field value: private", { field: "name" });
      }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("VALIDATION_FIELD");
    expect(JSON.stringify(body)).not.toContain("private");
  });

  it("returns INTERNAL for unexpected exceptions and captures them server-side", async () => {
    const failure = new Error("database credentials");
    const response = await withApiHardening(
      new Request("http://localhost/api/example"),
      { route: "example" },
      async () => {
        throw failure;
      }
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.code).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toContain("credentials");
    expect(mockCaptureException).toHaveBeenCalledWith(failure, { route: "example", method: "GET" });
  });
});
