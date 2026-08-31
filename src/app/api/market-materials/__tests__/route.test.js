import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "../route";

const { mockGetDb, mockCacheGet, mockCacheSet, mockGetOwnedMaterialIds } = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockCacheGet: vi.fn(),
  mockCacheSet: vi.fn(),
  mockGetOwnedMaterialIds: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({ getDb: mockGetDb }));
vi.mock("@/lib/cache/redis", () => ({ cacheGet: mockCacheGet, cacheSet: mockCacheSet }));
vi.mock("@/lib/entitlement", () => ({ getOwnedMaterialIds: mockGetOwnedMaterialIds }));

const BUYER = "gbuyer123";

function makeMaterial(materialId, overrides = {}) {
  return {
    _id: materialId,
    materialId,
    title: `Material ${materialId}`,
    visibility: "public",
    price: 10,
    createdAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function fakeSearchCollection(docs) {
  return {
    find: () => ({
      sort: () => ({
        limit: () => ({ toArray: async () => docs }),
        skip: () => ({ limit: () => ({ toArray: async () => docs }) }),
      }),
    }),
    countDocuments: async () => docs.length,
  };
}

function makeRequest(params = {}) {
  const search = new URLSearchParams(params);
  return new Request(`http://localhost:3000/api/market-materials?${search.toString()}`);
}

describe("GET /api/market-materials — entitlement-aware ranking (#707)", () => {
  const docs = [makeMaterial("m1"), makeMaterial("m2"), makeMaterial("m3")];

  beforeEach(() => {
    vi.clearAllMocks();
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
    mockGetDb.mockResolvedValue({
      collection: (name) => {
        if (name === "material_search_documents") return fakeSearchCollection(docs);
        throw new Error(`Unexpected collection: ${name}`);
      },
    });
    mockGetOwnedMaterialIds.mockResolvedValue(new Set());
  });

  it("does not call getOwnedMaterialIds or mark items when no buyerAddress is given", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(mockGetOwnedMaterialIds).not.toHaveBeenCalled();
    expect(body.items.every((item) => item.owned === undefined)).toBe(true);
    // Anonymous browsing still benefits from the shared cache.
    expect(mockCacheSet).toHaveBeenCalledTimes(1);
  });

  it("marks owned materials and reranks them after not-owned ones", async () => {
    mockGetOwnedMaterialIds.mockResolvedValue(new Set(["m2"]));

    const res = await GET(makeRequest({ buyerAddress: BUYER }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(mockGetOwnedMaterialIds).toHaveBeenCalledWith(
      expect.objectContaining({ buyerAddress: BUYER, materialIds: ["m1", "m2", "m3"] })
    );
    expect(body.items.map((item) => item.materialId)).toEqual(["m1", "m3", "m2"]);
    expect(body.items.map((item) => item.owned)).toEqual([false, false, true]);
  });

  it("bypasses the shared cache for a personalized (buyerAddress) request", async () => {
    await GET(makeRequest({ buyerAddress: BUYER }));

    expect(mockCacheGet).not.toHaveBeenCalled();
    expect(mockCacheSet).not.toHaveBeenCalled();
  });

  it("still returns results if the ownership lookup fails to resolve owned ids", async () => {
    mockGetOwnedMaterialIds.mockResolvedValue(new Set());

    const res = await GET(makeRequest({ buyerAddress: BUYER }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(3);
    expect(body.items.every((item) => item.owned === false)).toBe(true);
  });
});
