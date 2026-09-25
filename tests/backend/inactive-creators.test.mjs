import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMarketplaceDiscoveryQuery,
} from "../../src/lib/backend/marketplaceDiscovery.js";

function params(input) {
  return new URLSearchParams(input);
}

test("buildMarketplaceDiscoveryQuery excludes low-relevance items by default", () => {
  const query = buildMarketplaceDiscoveryQuery(params({}));

  assert.equal(query.visibility, "public");
  assert.ok(query.$or, "should have $or clause for relevanceStatus");
  assert.ok(
    query.$or.some(
      (clause) => clause.relevanceStatus && clause.relevanceStatus.$ne === "low"
    ),
    "should filter out relevanceStatus=low"
  );
  assert.ok(
    query.$or.some(
      (clause) => clause.relevanceStatus && clause.relevanceStatus.$exists === false
    ),
    "should include items without relevanceStatus field"
  );
});

test("buildMarketplaceDiscoveryQuery still includes items with relevanceStatus=normal", () => {
  const query = buildMarketplaceDiscoveryQuery(params({}));

  // Items with relevanceStatus "normal" or "high" should pass through
  // since $ne: "low" matches anything not equal to "low"
  const neClause = query.$or.find(
    (clause) => clause.relevanceStatus && clause.relevanceStatus.$ne === "low"
  );
  assert.ok(neClause, "ne clause exists");
  // The $ne: "low" will match "normal", "high", or any non-"low" value
});

test("buildMarketplaceDiscoveryQuery keeps other filters intact alongside relevance", () => {
  const query = buildMarketplaceDiscoveryQuery(
    params({ subject: "math", minPrice: "5" })
  );

  assert.equal(query.visibility, "public");
  assert.equal(query.subject, "math");
  assert.deepEqual(query.price, { $gte: 5 });
  assert.ok(query.$or, "relevance filter should coexist with other filters");
});
