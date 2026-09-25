import { describe, it, expect } from "vitest";
import {
  applyMarketplaceRelevanceRanking,
  applyOwnershipRanking,
  buildMarketplaceFacetPipeline,
  buildMarketplaceDiscoveryQuery,
  buildMarketplaceSearchClause,
  scoreMarketplaceItem,
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

describe("marketplace search and relevance (#767, #766)", () => {
  it("requires every search token while allowing a one-character near match", () => {
    const clause = buildMarketplaceSearchClause("calculus lesson");
    expect(clause.$and).toHaveLength(2);
    expect(clause.$and[0].$or.some((condition) => condition.title)).toBe(true);
    expect(clause.$and[0].$or[0].title.test("calclus")).toBe(true);
  });

  it("keeps a fresh complete listing competitive with a popular older listing", () => {
    const now = new Date("2026-09-25T00:00:00.000Z");
    const popularOld = {
      title: "calculus",
      description: "lesson",
      likes: 1000,
      rating: 5,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    };
    const freshComplete = {
      title: "calculus lesson",
      description: "A complete guide",
      shortSummary: "Practice problems",
      thumbnailUrl: "ipfs://thumb",
      likes: 10,
      rating: 4,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    };

    expect(scoreMarketplaceItem(freshComplete, "calculus lesson", { now }))
      .toBeGreaterThan(scoreMarketplaceItem(popularOld, "calculus lesson", { now }));
    expect(applyMarketplaceRelevanceRanking([popularOld, freshComplete], "calculus lesson", { now })[0])
      .toEqual(expect.objectContaining({ title: "calculus lesson" }));
  });

  it("builds facet counts from the same filtered query", () => {
    const pipeline = buildMarketplaceFacetPipeline({ category: "Science" });
    expect(pipeline[0]).toEqual({ $match: { category: "Science" } });
    expect(pipeline[1].$facet.category).toEqual([
      { $match: { category: { $nin: [null, ""] } } },
      { $sortByCount: "$category" },
      { $limit: 50 },
    ]);
  });
});
