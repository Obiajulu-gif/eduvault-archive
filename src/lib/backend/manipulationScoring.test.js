import { describe, expect, it } from "vitest";
import { scoreListingManipulation } from "./manipulationScoring.js";

describe("listing manipulation scoring", () => {
  it("flags a near duplicate without rejecting it", () => {
    const result = scoreListingManipulation(
      { _id: "new", title: "Algebra study guide", description: "linear equations and algebra practice" },
      [{ _id: "old", title: "Algebra study guide", description: "linear equations and algebra practice" }],
    );
    expect(result.flagged).toBe(true);
    expect(result.reasons).toContain("near_duplicate_listing");
  });
});