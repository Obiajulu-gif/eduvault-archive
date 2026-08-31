import { describe, it, expect } from "vitest";
import {
  applyOwnershipRanking,
  buildMarketplaceDiscoveryQuery,
} from "./marketplaceDiscovery";

describe("applyOwnershipRanking (#707)", () => {
  it("marks every item with an owned boolean", () => {
    const items = [
      { materialId: "m1" },
      { materialId: "m2" },
      { materialId: "m3" },
    ];
    const ownedIds = new Set(["m2"]);

    const result = applyOwnershipRanking(items, ownedIds);

    expect(result.map((item) => item.owned)).toEqual([false, false, true]);
  });

  it("reranks owned materials after not-owned ones, preserving relative order within each group", () => {
    const items = [
      { materialId: "a" },
      { materialId: "b" }, // owned
      { materialId: "c" },
      { materialId: "d" }, // owned
      { materialId: "e" },
    ];
    const ownedIds = new Set(["b", "d"]);

    const result = applyOwnershipRanking(items, ownedIds);

    expect(result.map((item) => item.materialId)).toEqual(["a", "c", "e", "b", "d"]);
  });

  it("is a no-op ordering when nothing in the page is owned", () => {
    const items = [{ materialId: "x" }, { materialId: "y" }];

    const result = applyOwnershipRanking(items, new Set());

    expect(result.map((item) => item.materialId)).toEqual(["x", "y"]);
    expect(result.every((item) => item.owned === false)).toBe(true);
  });

  it("falls back to _id when materialId is absent", () => {
    const items = [{ _id: "mongo-id-1" }];
    const ownedIds = new Set(["mongo-id-1"]);

    const result = applyOwnershipRanking(items, ownedIds);

    expect(result[0].owned).toBe(true);
  });

  it("does not mutate the input items", () => {
    const items = [{ materialId: "m1" }];
    const original = { ...items[0] };

    applyOwnershipRanking(items, new Set(["m1"]));

    expect(items[0]).toEqual(original);
  });
});

describe("buildMarketplaceDiscoveryQuery filters (#707)", () => {
  it("filters by subject, level, and language together with price range", () => {
    const params = new URLSearchParams({
      subject: "Mathematics",
      level: "Beginner",
      language: "Spanish",
      minPrice: "5",
      maxPrice: "50",
    });

    const query = buildMarketplaceDiscoveryQuery(params);

    expect(query.subject).toBe("Mathematics");
    expect(query.level).toBe("Beginner");
    expect(query.language).toBeInstanceOf(RegExp);
    expect(query.language.test("spanish")).toBe(true);
    expect(query.price).toEqual({ $gte: 5, $lte: 50 });
  });
});
