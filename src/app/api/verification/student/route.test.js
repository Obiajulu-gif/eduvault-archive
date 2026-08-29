import { describe, it, expect, vi } from "vitest";

const { mockDb, mockEnqueueSideEffect } = vi.hoisted(() => {
  const collections = new Map();

  function makeCollection() {
    return {
      findOne: vi.fn().mockResolvedValue(null),
      insertOne: vi.fn().mockResolvedValue({ insertedId: "verification-123" }),
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
      createIndex: vi.fn(),
    };
  }

  return {
    mockDb: {
      collection: vi.fn((name) => {
        if (!collections.has(name)) collections.set(name, makeCollection());
        return collections.get(name);
      }),
    },
    mockEnqueueSideEffect: vi.fn(),
  };
});

const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJ";

vi.mock("@/lib/auth/session", () => ({
  validateAuth: vi.fn().mockResolvedValue({ valid: true, address: WALLET }),
}));

vi.mock("@/lib/mongodb", () => ({
  connectToDatabase: vi.fn().mockResolvedValue({ db: mockDb }),
}));

vi.mock("@/lib/api/hardening", () => ({
  withApiHardening: vi.fn((req, options, handler) => handler()),
}));

vi.mock("@/lib/api/audit", () => ({
  auditLog: vi.fn(),
}));

vi.mock("@/lib/ipfs/uploadValidator", () => ({
  validateUploadedFile: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock("@/lib/pinata", () => ({
  pinata: {
    upload: {
      public: {
        file: vi.fn().mockResolvedValue({ cid: "QmMockVerificationDoc" }),
      },
    },
    gateways: {
      public: {
        convert: vi.fn().mockResolvedValue("https://gateway.pinata.cloud/ipfs/QmMockVerificationDoc"),
      },
    },
  },
}));

vi.mock("@/lib/publishing/quarantine", () => ({
  createQuarantineRecord: vi.fn().mockResolvedValue({
    state: "pending",
    contentHash: "QmMockVerificationDoc",
  }),
}));

vi.mock("@/lib/backend/outbox", () => ({
  enqueueSideEffect: mockEnqueueSideEffect,
}));

import { POST } from "./route";
import { validateUploadedFile } from "@/lib/ipfs/uploadValidator";
import { withApiHardening } from "@/lib/api/hardening";
import { createQuarantineRecord } from "@/lib/publishing/quarantine";

function buildRequest(overrides = {}) {
  const formData = new FormData();
  formData.set("walletAddress", WALLET);
  formData.set("fullName", "Jane Learner");
  formData.set("email", "jane@example.com");
  formData.set("institution", "Example University");
  formData.set("studentId", "STU-2026-0001");
  formData.set("expectedGraduation", "2027-06-30");
  formData.set(
    "document",
    overrides.document ??
      new File(["pdf-bytes"], "id-card.pdf", { type: "application/pdf" }),
  );
  return { formData: async () => formData, headers: new Headers() };
}

describe("POST /api/verification/student", () => {
  it("rejects a document whose magic number does not match its declared type", async () => {
    validateUploadedFile.mockResolvedValueOnce({
      valid: false,
      reason: 'File header does not match declared MIME type "application/pdf".',
    });

    const res = await POST(buildRequest());
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/File header does not match/);
    // Nothing may be stored or queued for moderator review on a bad file.
    expect(mockDb.collection("student_verifications").insertOne).not.toHaveBeenCalled();
    expect(mockDb.collection("admin_moderation_queue").insertOne).not.toHaveBeenCalled();
    expect(createQuarantineRecord).not.toHaveBeenCalled();
  });

  it("applies a strict per-account rate limit via withApiHardening", async () => {
    await POST(buildRequest());

    expect(withApiHardening).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        route: "verification/student",
        rateLimit: { limit: 5, windowMs: 3_600_000 },
      }),
      expect.any(Function),
    );
  });

  it("submits successfully and routes the document through quarantine", async () => {
    const res = await POST(buildRequest());
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.success).toBe(true);
    expect(json.status).toBe("pending");

    expect(createQuarantineRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        contentHash: "QmMockVerificationDoc",
        fileName: "id-card.pdf",
        mimeType: "application/pdf",
        uploaderAddress: WALLET.toLowerCase(),
      }),
    );
    expect(mockEnqueueSideEffect).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceAggregate: "quarantine",
        sourceId: "QmMockVerificationDoc",
      }),
    );

    const verificationInsert = mockDb.collection("student_verifications").insertOne;
    expect(verificationInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        walletAddress: WALLET.toLowerCase(),
        document: expect.objectContaining({
          contentHash: "QmMockVerificationDoc",
          quarantineState: "pending",
        }),
      }),
    );
  });

  it("returns 401 when the caller is not authenticated", async () => {
    const { validateAuth } = await import("@/lib/auth/session");
    validateAuth.mockResolvedValueOnce({ valid: false });

    const res = await POST(buildRequest());
    expect(res.status).toBe(401);
  });
});
