import { describe, expect, it } from "vitest";
import { buildMarketplaceCursorClause, buildMarketplaceSort, decodeMarketplaceCursor, encodeMarketplaceCursor } from "./marketplaceDiscovery.js";

describe("marketplace keyset pagination", () => {
  it("keeps a compound cursor stable when a new listing is inserted", () => {
    const sort = buildMarketplaceSort("price_asc");
    const cursor = encodeMarketplaceCursor({ _id: "507f1f77bcf86cd799439011", price: 10, createdAt: new Date("2026-01-01") }, sort);
    const decoded = decodeMarketplaceCursor(cursor, sort);
    const clause = buildMarketplaceCursorClause(decoded, sort);
    expect(clause.$or).toHaveLength(3);
    expect(clause.$or[0].price.$gt).toBe(10);
    expect(clause.$or[2]._id.$gt.toString()).toBe("507f1f77bcf86cd799439011");
  });
});