import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMarketplaceDiscoveryQuery,
  buildMarketplaceSort,
} from "../../src/lib/backend/marketplaceDiscovery.js";

function params(input) {
  return new URLSearchParams(input);
}

test("buildMarketplaceDiscoveryQuery combines all discovery filters", () => {
  const query = buildMarketplaceDiscoveryQuery(
    params({
      search: "cell biology",
      subject: "biology",
      level: "advanced",
      contentType: "pdf",
      minPrice: "2",
      maxPrice: "10",
      licenseType: "creative-commons",
      minRating: "4",
      newest: "30d",
    }),
    { now: new Date("2026-06-25T00:00:00.000Z") }
  );

  assert.equal(query.visibility, "public");
  assert.equal(query.subject, "biology");
  assert.equal(query.level, "advanced");
  assert.deepEqual(query.price, { $gte: 2, $lte: 10 });
  assert.equal(query.usageRights, "Creative Commons");
  assert.deepEqual(query.rating, { $gte: 4 });
  assert.deepEqual(query.createdAt, { $gte: new Date("2026-05-26T00:00:00.000Z") });
  assert.equal(query.$and.length, 2);
  assert.ok(query.$and[0].$or.some((condition) => condition.title));
  assert.ok(query.$and[1].$or.some((condition) => condition.fileType));
});

test("buildMarketplaceDiscoveryQuery ignores invalid numeric filters", () => {
  const query = buildMarketplaceDiscoveryQuery(
    params({
      minPrice: "free",
      maxPrice: "",
      minRating: "stars",
    })
  );

  assert.equal(query.price, undefined);
  assert.equal(query.rating, undefined);
});

test("buildMarketplaceSort supports newest, rating, popular, and price order", () => {
  assert.deepEqual(buildMarketplaceSort("newest"), { createdAt: -1 });
  assert.deepEqual(buildMarketplaceSort("rating_desc"), { rating: -1, createdAt: -1 });
  assert.deepEqual(buildMarketplaceSort("popular"), { likes: -1, rating: -1, createdAt: -1 });
  assert.deepEqual(buildMarketplaceSort("price_asc"), { price: 1, createdAt: -1 });
  assert.deepEqual(buildMarketplaceSort("price_desc"), { price: -1, createdAt: -1 });
});

test("buildMarketplaceDiscoveryQuery handles language filter and unknown language fallback", () => {
  const queryEng = buildMarketplaceDiscoveryQuery(params({ language: "Spanish" }));
  assert.deepEqual(queryEng.language, /^Spanish$/i);

  const queryUnknown = buildMarketplaceDiscoveryQuery(params({ language: "Unknown" }));
  assert.ok(queryUnknown.$and);
  assert.ok(queryUnknown.$and.some(clause => clause.$or && clause.$or.some(c => c.language === "Unknown")));
});
