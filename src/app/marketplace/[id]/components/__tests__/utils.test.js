import { describe, it, expect } from "vitest";
import {
  getPreviewImage,
  getPreviewCounts,
  hasCoverImage,
  getAverageScore,
  getFeedbackCount,
  getAccessCopy,
} from "../utils";

describe("getPreviewImage", () => {
  it("returns coverImageUrl when available", () => {
    expect(getPreviewImage({ coverImageUrl: "/cover.png" })).toBe("/cover.png");
  });
  it("falls back to thumbnailUrl", () => {
    expect(getPreviewImage({ thumbnailUrl: "/thumb.png" })).toBe("/thumb.png");
  });
  it("falls back to image", () => {
    expect(getPreviewImage({ image: "/img.png" })).toBe("/img.png");
  });
  it("returns fallback when nothing is provided", () => {
    expect(getPreviewImage({})).toBe("/images/image2.jpg");
  });
});

describe("getPreviewCounts", () => {
  it("counts arrays correctly", () => {
    expect(getPreviewCounts({ learningOutcomes: ["a", "b"], tableOfContents: ["x"], sampleNotes: ["p", "q", "r"] }))
      .toEqual({ outcomes: 2, sections: 1, notes: 3 });
  });
  it("returns zeros for missing arrays", () => {
    expect(getPreviewCounts({})).toEqual({ outcomes: 0, sections: 0, notes: 0 });
  });
});

describe("hasCoverImage", () => {
  it("returns true when coverImageUrl exists", () => {
    expect(hasCoverImage({ coverImageUrl: "/img.png" })).toBe(true);
  });
  it("returns true when thumbnailUrl exists", () => {
    expect(hasCoverImage({ thumbnailUrl: "/img.png" })).toBe(true);
  });
  it("returns true when image exists", () => {
    expect(hasCoverImage({ image: "/img.png" })).toBe(true);
  });
  it("returns false when none exist", () => {
    expect(hasCoverImage({})).toBe(false);
  });
});

describe("getAverageScore", () => {
  it("returns formatted score when valid", () => {
    expect(getAverageScore({ averageScore: 4.5 })).toBe("4.5");
  });
  it("uses rating field as fallback", () => {
    expect(getAverageScore({ rating: 3.8 })).toBe("3.8");
  });
  it("returns 'New' for zero score", () => {
    expect(getAverageScore({ averageScore: 0 })).toBe("New");
  });
  it("returns 'New' for missing score", () => {
    expect(getAverageScore({})).toBe("New");
  });
});

describe("getFeedbackCount", () => {
  it("returns feedbackCount when available", () => {
    expect(getFeedbackCount({ feedbackCount: 10 })).toBe(10);
  });
  it("falls back to reviewsCount", () => {
    expect(getFeedbackCount({ reviewsCount: 5 })).toBe(5);
  });
  it("returns 0 for missing counts", () => {
    expect(getFeedbackCount({})).toBe(0);
  });
});

describe("getAccessCopy", () => {
  it("returns checking state when isLoading", () => {
    expect(getAccessCopy("active", true).label).toBe("Checking access");
  });
  it("returns active state", () => {
    const r = getAccessCopy("active", false);
    expect(r.label).toBe("Access granted");
    expect(r.className).toContain("emerald");
  });
  it("returns pending state", () => {
    const r = getAccessCopy("pending", false);
    expect(r.label).toBe("Payment pending");
    expect(r.className).toContain("amber");
  });
  it("returns payment_failed state", () => {
    const r = getAccessCopy("payment_failed", false);
    expect(r.label).toBe("Payment incomplete");
    expect(r.className).toContain("rose");
  });
  it("returns wallet_required state", () => {
    const r = getAccessCopy("wallet_required", false);
    expect(r.label).toBe("Wallet required");
    expect(r.className).toContain("blue");
  });
  it("returns default for unknown status", () => {
    expect(getAccessCopy("unknown", false).label).toBe("Payment required");
  });
});
