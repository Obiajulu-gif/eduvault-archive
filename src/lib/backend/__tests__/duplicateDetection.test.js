import { describe, expect, it } from "vitest";
import {
  buildDuplicateKey,
  createDuplicateReview,
  detectDuplicate,
  DUPLICATE_SEVERITY,
  normalizeTitle,
  resolveDuplicateReview,
  titleSimilarity,
} from "../duplicateDetection.js";

function makeDb() {
  const reviews = [];
  const collection = {
    insertOne: async (doc) => {
      reviews.push(doc);
      return { insertedId: doc._id };
    },
    findOneAndUpdate: async (query, update) => {
      const record = reviews.find((r) => r._id === query._id && r.status === query.status);
      if (!record) return null;
      Object.assign(record, update.$set);
      return { value: record };
    },
  };
  return { collection: () => collection, reviews };
}

describe("duplicate detection", () => {
  it("detects exact duplicates deterministically (same normalized title and storage key)", () => {
    const existing = [
      { _id: "mat_1", title: "Advanced Calculus Notes", storageKey: "QmHash123" },
    ];
    const result = detectDuplicate({
      title: "advanced calculus notes",
      storageKey: "QmHash123",
      existing,
    });
    expect(result.severity).toBe(DUPLICATE_SEVERITY.BLOCK);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].reason).toBe("exact_title_and_storage");
  });

  it("detects duplicates when only the storage key matches (same file, different title)", () => {
    const existing = [
      { _id: "mat_2", title: "Physics 101", storageKey: "QmHash456" },
    ];
    const result = detectDuplicate({
      title: "Completely Different Title",
      storageKey: "QmHash456",
      existing,
    });
    expect(result.severity).toBe(DUPLICATE_SEVERITY.BLOCK);
    expect(result.matches[0].reason).toBe("exact_storage_key");
  });

  it("flags near duplicates with high title similarity for review", () => {
    const existing = [
      { _id: "mat_3", title: "Advanced Calculus Notes for Engineering Students", storageKey: "QmHash789" },
    ];
    const result = detectDuplicate({
      title: "Advanced Calculus Notes for Engineering Students Revised",
      storageKey: "QmDifferent999",
      existing,
    });
    expect(result.severity).toBe(DUPLICATE_SEVERITY.REVIEW);
    expect(result.matches[0].reason).toBe("near_title");
    expect(result.matches[0].similarity).toBeGreaterThanOrEqual(0.85);
  });

  it("warns on moderate title similarity", () => {
    const existing = [
      { _id: "mat_4", title: "Data Structures and Algorithms in JavaScript", storageKey: "QmHash111" },
    ];
    const result = detectDuplicate({
      title: "Data Structures and Algorithms",
      storageKey: "QmHash222",
      existing,
    });
    expect(result.severity).toBe(DUPLICATE_SEVERITY.WARN);
    expect(result.matches[0].reason).toBe("possible_title");
  });

  it("allows completely different records (no false positive)", () => {
    const existing = [
      { _id: "mat_5", title: "Organic Chemistry Fundamentals", storageKey: "QmHash333" },
      { _id: "mat_6", title: "World History: Ancient Civilizations", storageKey: "QmHash444" },
    ];
    const result = detectDuplicate({
      title: "Advanced Quantum Computing",
      storageKey: "QmHash555",
      existing,
    });
    expect(result.severity).toBe(DUPLICATE_SEVERITY.NONE);
    expect(result.matches).toHaveLength(0);
  });

  it("does not false-positive on short or generic titles", () => {
    const existing = [
      { _id: "mat_7", title: "Notes", storageKey: "QmHash666" },
    ];
    const result = detectDuplicate({
      title: "Notes",
      storageKey: "QmHash777",
      existing,
    });
    // Same normalized title but different storage key — not an exact duplicate
    expect(result.severity).not.toBe(DUPLICATE_SEVERITY.BLOCK);
  });

  it("normalizes titles deterministically (case, punctuation, whitespace)", () => {
    expect(normalizeTitle("  Advanced   Calculus!  ")).toBe("advanced calculus");
    expect(normalizeTitle("ADVANCED CALCULUS")).toBe("advanced calculus");
    expect(normalizeTitle("advanced-calculus")).toBe("advanced calculus");
  });

  it("produces stable duplicate keys for identical canonical fields", () => {
    const key1 = buildDuplicateKey("Advanced Calculus", "QmHash123");
    const key2 = buildDuplicateKey("advanced calculus", "QmHash123");
    const key3 = buildDuplicateKey("Advanced Calculus", "QmHash456");
    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
  });

  it("computes title similarity correctly", () => {
    expect(titleSimilarity("machine learning", "machine learning")).toBe(1);
    expect(titleSimilarity("machine learning", "machine learning with python")).toBe(0.5);
    expect(titleSimilarity("completely different", "nothing alike")).toBe(0);
    expect(titleSimilarity("", "something")).toBe(0);
  });

  it("returns NONE for empty submissions", () => {
    const result = detectDuplicate({ title: "", storageKey: "", existing: [{ _id: "m", title: "x", storageKey: "y" }] });
    expect(result.severity).toBe(DUPLICATE_SEVERITY.NONE);
  });
});

describe("duplicate review workflow", () => {
  it("creates a review case for ambiguous matches and resolves it", async () => {
    const db = makeDb();
    const existing = [
      { _id: "mat_8", title: "Advanced Calculus Notes for Engineering Students", storageKey: "QmHash888" },
    ];
    const detection = detectDuplicate({
      title: "Advanced Calculus Notes for Engineering Students Revised",
      storageKey: "QmHash999",
      existing,
    });
    expect(detection.severity).toBe(DUPLICATE_SEVERITY.REVIEW);

    const reviewId = await createDuplicateReview(db, {
      submittedTitle: "Advanced Calculus Notes for Engineering Students Revised",
      submittedStorageKey: "QmHash999",
      matches: detection.matches,
      submitterId: "user_1",
    });
    expect(reviewId).toBeTruthy();
    expect(db.reviews).toHaveLength(1);
    expect(db.reviews[0].status).toBe("pending");

    const resolved = await resolveDuplicateReview(db, reviewId, "allowed", "admin_1");
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution).toBe("allowed");
    expect(resolved.resolvedBy).toBe("admin_1");
  });

  it("allows maintainers to resolve as duplicate", async () => {
    const db = makeDb();
    const reviewId = await createDuplicateReview(db, {
      submittedTitle: "Duplicate Title",
      submittedStorageKey: "QmHash",
      matches: [],
      submitterId: "user_2",
    });

    const resolved = await resolveDuplicateReview(db, reviewId, "duplicate", "admin_2");
    expect(resolved.resolution).toBe("duplicate");
    expect(resolved.status).toBe("resolved");
  });

  it("rejects invalid resolution values", async () => {
    const db = makeDb();
    await expect(
      resolveDuplicateReview(db, "nonexistent", "invalid", "admin_1")
    ).rejects.toThrow("Resolution must be 'duplicate' or 'allowed'");
  });

  it("returns null when resolving an already-resolved review", async () => {
    const db = makeDb();
    const reviewId = await createDuplicateReview(db, {
      submittedTitle: "Title",
      submittedStorageKey: "Key",
      matches: [],
      submitterId: "user_3",
    });

    await resolveDuplicateReview(db, reviewId, "allowed", "admin_1");
    const second = await resolveDuplicateReview(db, reviewId, "duplicate", "admin_2");
    expect(second).toBeNull();
  });
});
