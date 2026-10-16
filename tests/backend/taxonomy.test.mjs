import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  normalizeSubject,
  normalizeCategory,
  normalizeLevel,
  validateCategorySubject,
  getTaxonomy,
  getSubjectById,
  getCategoryById,
  getSubjectsByCategory,
} from "../../src/lib/backend/taxonomy.js";

describe("normalizeSubject", () => {
  test("normalizes by label", () => {
    const result = normalizeSubject("Math");
    assert.equal(result.id, "mathematics");
    assert.equal(result.label, "Math");
    assert.equal(result.categoryId, "academic");
  });

  test("normalizes by alias", () => {
    const result = normalizeSubject("algebra");
    assert.equal(result.id, "mathematics");
    assert.equal(result.label, "Math");
  });

  test("normalizes by ID", () => {
    const result = normalizeSubject("social-sciences");
    assert.equal(result.id, "social-sciences");
    assert.equal(result.label, "Social Sciences");

    const result2 = normalizeSubject("test-prep");
    assert.equal(result2.id, "test-prep");
    assert.equal(result2.label, "Test Preparation");
  });

  test("returns null for unknown subject", () => {
    assert.equal(normalizeSubject("astrology"), null);
  });

  test("returns null for empty input", () => {
    assert.equal(normalizeSubject(""), null);
    assert.equal(normalizeSubject(null), null);
    assert.equal(normalizeSubject(undefined), null);
  });
});

describe("normalizeCategory", () => {
  test("normalizes by id", () => {
    const result = normalizeCategory("academic");
    assert.equal(result.id, "academic");
    assert.equal(result.label, "Academic");
  });

  test("normalizes by label", () => {
    const result = normalizeCategory("Academic");
    assert.equal(result.id, "academic");
  });

  test("returns null for unknown category", () => {
    assert.equal(normalizeCategory("unknown"), null);
  });
});

describe("normalizeLevel", () => {
  test("normalizes by id", () => {
    const result = normalizeLevel("beginner");
    assert.equal(result.id, "beginner");
    assert.equal(result.label, "Beginner");
  });

  test("normalizes by label", () => {
    const result = normalizeLevel("Advanced");
    assert.equal(result.id, "advanced");
  });

  test("returns null for unknown level", () => {
    assert.equal(normalizeLevel("expert"), null);
  });
});

describe("validateCategorySubject", () => {
  test("passes when subject belongs to category", () => {
    const result = validateCategorySubject("academic", "mathematics");
    assert.equal(result.valid, true);
  });

  test("fails when subject does not belong to category", () => {
    const result = validateCategorySubject("professional", "mathematics");
    assert.equal(result.valid, false);
    assert.ok(result.error.includes("does not belong"));
  });

  test("passes when no category or subject provided", () => {
    assert.equal(validateCategorySubject(null, null).valid, true);
  });
});

describe("getTaxonomy", () => {
  test("returns categories, subjects, and levels", () => {
    const taxonomy = getTaxonomy();
    assert.ok(Array.isArray(taxonomy.categories));
    assert.ok(taxonomy.categories.length > 0);
    assert.ok(Array.isArray(taxonomy.subjects));
    assert.ok(taxonomy.subjects.length > 0);
    assert.ok(Array.isArray(taxonomy.levels));
    assert.equal(taxonomy.levels.length, 4);
  });
});

describe("getSubjectById", () => {
  test("returns subject by id", () => {
    const result = getSubjectById("mathematics");
    assert.equal(result.label, "Math");
  });

  test("returns null for unknown id", () => {
    assert.equal(getSubjectById("unknown"), null);
  });
});

describe("getCategoryById", () => {
  test("returns category by id", () => {
    const result = getCategoryById("academic");
    assert.equal(result.label, "Academic");
  });

  test("returns null for unknown id", () => {
    assert.equal(getCategoryById("unknown"), null);
  });
});

describe("getSubjectsByCategory", () => {
  test("returns subjects for a category", () => {
    const subjects = getSubjectsByCategory("academic");
    assert.ok(subjects.length > 0);
    subjects.forEach((s) => assert.equal(s.categoryId, "academic"));
  });

  test("returns empty array for category with no subjects", () => {
    assert.deepEqual(getSubjectsByCategory("research"), []);
  });
});
