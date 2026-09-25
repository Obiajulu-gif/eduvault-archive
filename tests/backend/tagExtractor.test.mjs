import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { suggestTags, getTagPool } from "../../src/lib/utils/tagExtractor.js";

describe("tagExtractor utility", () => {
  test("getTagPool returns a non-empty tag pool list containing expected tags", () => {
    const pool = getTagPool();
    assert.ok(Array.isArray(pool));
    assert.ok(pool.length > 0);
    assert.ok(pool.includes("Calculus"));
    assert.ok(pool.includes("Chemistry"));
    assert.ok(pool.includes("MicroEconomics"));
    assert.ok(pool.includes("UNN"));
  });

  test("suggestTags extracts exact matching tags from the pool", () => {
    const result = suggestTags(
      "Introductory Lecture on Calculus and Integration rules",
      "We will explore differentiation rules and calculus theorems."
    );

    assert.ok(result.tags.includes("Calculus"));
    assert.ok(result.tags.length <= 5);
  });

  test("suggestTags filters out stop words and document descriptors", () => {
    const result = suggestTags(
      "The complete lecture notes for a student",
      "A very useful guide with templates"
    );
    assert.deepEqual(result.tags, []);
  });

  test("suggestTags falls back to highest frequency custom words if pool matches are fewer than 5", () => {
    const result = suggestTags(
      "Specialized Cryptography Course SEC404",
      "Analyzing encryption and hashing algorithms."
    );

    assert.ok(result.tags.length > 0);
    // SEC404 should be detected as a custom tag and capitalized since it matches course code pattern
    assert.ok(result.tags.includes("SEC404"));
    // Other words like cryptography should be capitalized
    assert.ok(result.tags.includes("Cryptography"));
  });

  test("suggestTags runs in under 50ms", () => {
    const startTime = performance.now();
    const result = suggestTags(
      "ECO 201 - Principles of Microeconomics (Complete Lecture Notes)",
      "A creator-written guide that breaks down demand, supply, market equilibrium, elasticity, and production theory into an exam-friendly summary."
    );
    const duration = performance.now() - startTime;

    assert.ok(duration < 50, `Execution took ${duration}ms, which is not under 50ms`);
    assert.ok(result.durationMs < 50, `Internal measurement ${result.durationMs}ms is not under 50ms`);
  });
});
