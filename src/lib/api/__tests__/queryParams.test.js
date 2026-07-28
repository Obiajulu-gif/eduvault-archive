import { describe, it, expect } from "vitest";

import { buildQueryParams } from "../queryParams";

describe("buildQueryParams", () => {
  it("keeps defined values", () => {
    const params = buildQueryParams({ search: "algebra", page: 2 });
    expect(params.get("search")).toBe("algebra");
    expect(params.get("page")).toBe("2");
  });

  it("skips undefined, null, and empty-string values", () => {
    const params = buildQueryParams({
      search: "algebra",
      subject: undefined,
      category: null,
      level: "",
    });
    expect(params.toString()).toBe("search=algebra");
    expect(params.has("subject")).toBe(false);
    expect(params.has("category")).toBe(false);
    expect(params.has("level")).toBe(false);
  });

  it("never serializes the literal string undefined", () => {
    const params = buildQueryParams({ subject: undefined });
    expect(params.toString()).not.toContain("undefined");
  });

  it("keeps falsy-but-meaningful values like 0 and false", () => {
    const params = buildQueryParams({ minPrice: 0, free: false });
    expect(params.get("minPrice")).toBe("0");
    expect(params.get("free")).toBe("false");
  });

  it("returns an empty result for an empty or omitted object", () => {
    expect(buildQueryParams().toString()).toBe("");
    expect(buildQueryParams({}).toString()).toBe("");
  });
});
