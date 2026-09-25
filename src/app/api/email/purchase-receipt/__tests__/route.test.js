import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetUserFromCookie,
  mockSendReceiptIfEligible,
  mockGetDb,
  mockWithApiHardening,
} = vi.hoisted(() => ({
  mockGetUserFromCookie: vi.fn(),
  mockSendReceiptIfEligible: vi.fn(),
  mockGetDb: vi.fn(),
  mockWithApiHardening: vi.fn(),
}));

vi.mock("@/lib/api/auth", () => ({ getUserFromCookie: mockGetUserFromCookie }));
vi.mock("@/lib/email", () => ({ sendReceiptIfEligible: mockSendReceiptIfEligible }));
vi.mock("@/lib/mongodb", () => ({ getDb: mockGetDb }));
vi.mock("@/lib/api/hardening", () => ({ withApiHardening: mockWithApiHardening }));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { POST } from "../route";

function makeRequest(body) {
  return new Request("http://localhost:3000/api/email/purchase-receipt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("POST /api/email/purchase-receipt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithApiHardening.mockImplementation(async (_req, _opts, handler) => handler());
    mockGetUserFromCookie.mockResolvedValue({ walletAddress: "GABC123" });
  });

  function setupDb({ purchase = null } = {}) {
    const fakePurchases = purchase
      ? { docs: [purchase], findOne: vi.fn().mockResolvedValue(purchase) }
      : { docs: [], findOne: vi.fn().mockResolvedValue(null) };

    mockGetDb.mockResolvedValue({
      collection: (name) => {
        if (name === "purchases") return fakePurchases;
        throw new Error(`Unexpected collection: ${name}`);
      },
    });
  }

  it("returns 401 when unauthenticated", async () => {
    mockGetUserFromCookie.mockResolvedValue(null);
    setupDb();

    const res = await POST(makeRequest({ purchaseId: "507f1f77bcf86cd799439011" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when purchaseId is missing", async () => {
    setupDb();
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when purchaseId is not a string", async () => {
    setupDb();
    const res = await POST(makeRequest({ purchaseId: 12345 }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when purchaseId is not a valid ObjectId", async () => {
    setupDb();
    const res = await POST(makeRequest({ purchaseId: "not-valid" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when purchase is not found", async () => {
    setupDb({ purchase: null });
    const res = await POST(makeRequest({ purchaseId: "507f1f77bcf86cd799439011" }));
    expect(res.status).toBe(404);
  });

  it("returns 400 when purchase status is not completed", async () => {
    setupDb({
      purchase: {
        _id: { toString: () => "507f1f77bcf86cd799439011" },
        status: "pending",
        buyerAddress: "GABC123",
      },
    });
    const res = await POST(makeRequest({ purchaseId: "507f1f77bcf86cd799439011" }));
    expect(res.status).toBe(400);
  });

  it("returns 200 when receipt was already sent", async () => {
    setupDb({
      purchase: {
        _id: { toString: () => "507f1f77bcf86cd799439011" },
        status: "confirmed",
        receiptSent: true,
        buyerAddress: "GABC123",
      },
    });
    const res = await POST(makeRequest({ purchaseId: "507f1f77bcf86cd799439011" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.message).toMatch(/already sent/i);
    expect(mockSendReceiptIfEligible).not.toHaveBeenCalled();
  });

  it("enqueues receipt and returns 200 for eligible purchase", async () => {
    setupDb({
      purchase: {
        _id: { toString: () => "507f1f77bcf86cd799439011" },
        status: "confirmed",
        buyerAddress: "GABC123",
      },
    });
    mockSendReceiptIfEligible.mockResolvedValue(undefined);

    const res = await POST(makeRequest({ purchaseId: "507f1f77bcf86cd799439011" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.message).toMatch(/enqueued/i);
    expect(mockSendReceiptIfEligible).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when sendReceiptIfEligible throws", async () => {
    setupDb({
      purchase: {
        _id: { toString: () => "507f1f77bcf86cd799439011" },
        status: "confirmed",
        buyerAddress: "GABC123",
      },
    });
    mockSendReceiptIfEligible.mockRejectedValue(new Error("SMTP connection failed"));

    const res = await POST(makeRequest({ purchaseId: "507f1f77bcf86cd799439011" }));
    expect(res.status).toBe(500);
  });

  it("passes through withApiHardening options", async () => {
    setupDb({ purchase: null });
    await POST(makeRequest({ purchaseId: "507f1f77bcf86cd799439011" }));
    expect(mockWithApiHardening).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ route: "email/purchase-receipt" }),
      expect.any(Function),
    );
  });
});
