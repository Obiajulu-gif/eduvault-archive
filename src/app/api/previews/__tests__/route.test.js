import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";

const mockGetDb = vi.fn();
const mockWithApiHardening = vi.fn();

vi.mock("@/lib/mongodb", () => ({ getDb: mockGetDb }));
vi.mock("@/lib/api/hardening", () => ({ withApiHardening: mockWithApiHardening }));

const { GET } = await import("../[materialId]/route");
const { PREVIEW_STATES } = await import("@/lib/backend/previewStore");

function dbWith({ material, preview }) {
  return {
    collection(name) {
      if (name === "materials") return { findOne: async () => material };
      if (name === "material_previews") return { findOne: async (q) => (preview && preview.contentHash === q.contentHash ? preview : null) };
      return { findOne: async () => null };
    },
  };
}

const req = () => new Request("http://localhost/api/previews/000000000000000000000001");
const params = { params: Promise.resolve({ materialId: "000000000000000000000001" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mockWithApiHardening.mockImplementation((r, o, handler) => handler());
});

describe("GET /api/previews/[materialId]", () => {
  it("returns the descriptor with a locked-down header set when the preview is ready", async () => {
    mockGetDb.mockResolvedValue(
      dbWith({
        material: { _id: new ObjectId("000000000000000000000001"), storageKey: "QmReady", visibility: "public" },
        preview: { contentHash: "QmReady", state: PREVIEW_STATES.READY, descriptor: { kind: "archive", flags: ["macro"] }, previewerVersion: "structural-1" },
      }),
    );

    const res = await GET(req(), params);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");

    const body = await res.json();
    expect(body.state).toBe("ready");
    expect(body.descriptor.kind).toBe("archive");
    expect(body).not.toHaveProperty("storageKey");
    expect(body).not.toHaveProperty("url");
  });

  it("returns 425 while the preview is still pending", async () => {
    mockGetDb.mockResolvedValue(
      dbWith({
        material: { _id: new ObjectId("000000000000000000000001"), storageKey: "QmPending" },
        preview: { contentHash: "QmPending", state: PREVIEW_STATES.PENDING, descriptor: null },
      }),
    );
    const res = await GET(req(), params);
    expect(res.status).toBe(425);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("returns 404 (never the original file) when preview generation failed", async () => {
    mockGetDb.mockResolvedValue(
      dbWith({
        material: { _id: new ObjectId("000000000000000000000001"), storageKey: "QmFailed" },
        preview: { contentHash: "QmFailed", state: PREVIEW_STATES.FAILED, descriptor: null, reason: "sandbox timeout" },
      }),
    );
    const res = await GET(req(), params);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.state).toBe("failed");
    expect(JSON.stringify(body)).not.toContain("QmFailed");
  });

  it("returns 404 when the material does not exist", async () => {
    mockGetDb.mockResolvedValue(dbWith({ material: null }));
    const res = await GET(req(), params);
    expect(res.status).toBe(404);
  });

  it("returns 425 when the material exists but no preview row was created", async () => {
    mockGetDb.mockResolvedValue(dbWith({ material: { _id: new ObjectId("000000000000000000000001"), storageKey: "QmNoRow" }, preview: null }));
    const res = await GET(req(), params);
    expect(res.status).toBe(425);
  });
});
