import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { suggestTags, getTagPool } from "../tagExtractor.js";
import { getTaxonomy } from "../../backend/taxonomy.js";

describe("tagExtractor - suggestTags (#607)", () => {
  describe("Representative domain fixtures", () => {
    it("suggests sensible tags for ECO 201 Microeconomics material", () => {
      const title = "ECO 201 - Principles of Microeconomics (Complete Lecture Notes)";
      const description = "A creator-written guide that breaks down demand, supply, market equilibrium, elasticity, and production theory.";
      const result = suggestTags(title, description);

      assert.ok(result);
      assert.ok(Array.isArray(result.tags));
      assert.ok(result.tags.length > 0);
      assert.ok(result.tags.length <= 5);

      const tagsUpper = result.tags.map(t => t.toUpperCase());
      const hasExpectedKey = tagsUpper.some(t => t.includes("ECO201") || t.includes("MICROECONOMICS") || t.includes("ECO"));
      assert.strictEqual(hasExpectedKey, true);
    });

    it("suggests sensible tags for MTH 101 Calculus sheet", () => {
      const title = "MTH 101 - Calculus Cheat Sheet";
      const description = "Compact revision sheet with limits, derivatives, integration shortcuts, and quick reminders for calculus exams.";
      const result = suggestTags(title, description);

      assert.ok(Array.isArray(result.tags));
      assert.ok(result.tags.length > 0);
      const tagsUpper = result.tags.map(t => t.toUpperCase());
      const hasExpectedKey = tagsUpper.some(t => t.includes("CALCULUS") || t.includes("MTH101") || t.includes("MATH") || t.includes("MTH"));
      assert.strictEqual(hasExpectedKey, true);
    });

    it("suggests sensible tags for CHM 112 Lab Report Template", () => {
      const title = "CHM 112 - Lab Report Template (UNN)";
      const description = "Structured lab template for chemistry reports with clean format for objectives, calculations, and conclusions.";
      const result = suggestTags(title, description);

      assert.ok(Array.isArray(result.tags));
      assert.ok(result.tags.length > 0);
      const tagsUpper = result.tags.map(t => t.toUpperCase());
      const hasExpectedKey = tagsUpper.some(t => t.includes("CHEMISTRY") || t.includes("CHM112") || t.includes("CHM") || t.includes("UNN"));
      assert.strictEqual(hasExpectedKey, true);
    });
  });

  describe("Edge cases", () => {
    it("handles empty title with description only", () => {
      const result = suggestTags("", "Comprehensive guide covering advanced quantum physics and thermodynamics equations.");
      assert.ok(Array.isArray(result.tags));
      assert.strictEqual(typeof result.durationMs, "number");
      assert.strictEqual(Number.isFinite(result.durationMs), true);
      assert.ok(result.durationMs >= 0);
      assert.ok(result.tags.length > 0);
    });

    it("handles empty description with title only", () => {
      const result = suggestTags("BIO 201 - Human Anatomy Notes", "");
      assert.ok(Array.isArray(result.tags));
      assert.strictEqual(typeof result.durationMs, "number");
      assert.strictEqual(Number.isFinite(result.durationMs), true);
      assert.ok(result.durationMs >= 0);
      assert.ok(result.tags.length > 0);
    });

    it("handles both title and description empty or null", () => {
      const result1 = suggestTags("", "");
      assert.deepStrictEqual(result1.tags, []);
      assert.strictEqual(typeof result1.durationMs, "number");
      assert.strictEqual(Number.isFinite(result1.durationMs), true);

      const result2 = suggestTags(null, null);
      assert.deepStrictEqual(result2.tags, []);
      assert.strictEqual(typeof result2.durationMs, "number");
      assert.strictEqual(Number.isFinite(result2.durationMs), true);
    });

    it("handles very short single-word title", () => {
      const result = suggestTags("Algebra", "");
      assert.ok(Array.isArray(result.tags));
      assert.ok(result.tags.length > 0);
      const lowerTags = result.tags.map(t => t.toLowerCase());
      assert.ok(lowerTags.includes("algebra"));
    });

    it("handles input containing only stopwords and noise", () => {
      const result = suggestTags("the a and of", "notes summary guide lecture exam complete");
      assert.ok(Array.isArray(result.tags));
      assert.deepStrictEqual(result.tags, []);
      assert.strictEqual(typeof result.durationMs, "number");
      assert.strictEqual(Number.isFinite(result.durationMs), true);
    });

    it("handles non-English characters and unusual punctuation", () => {
      const title = "Économie & Statistique - L'analyse de données!!! (Niveau 200)";
      const description = "Ce cours couvre l'économétrie, les probabilités et la modélisation statistique pour étudiants.";
      const result = suggestTags(title, description);

      assert.ok(Array.isArray(result.tags));
      assert.strictEqual(typeof result.durationMs, "number");
      assert.strictEqual(Number.isFinite(result.durationMs), true);
      assert.ok(result.durationMs >= 0);
    });

    it("handles extremely long input gracefully without hanging or unbounded tags", () => {
      const longTitle = "ECO 201 " + "Microeconomics ".repeat(500);
      const longDescription = "Detailed analysis of market equilibrium ".repeat(5000);
      
      const startTime = performance.now();
      const result = suggestTags(longTitle, longDescription);
      const totalTimeMs = performance.now() - startTime;

      assert.ok(Array.isArray(result.tags));
      assert.ok(result.tags.length <= 5);
      assert.strictEqual(typeof result.durationMs, "number");
      assert.strictEqual(Number.isFinite(result.durationMs), true);
      assert.ok(totalTimeMs < 1000);
    });
  });

  describe("Timing metric (durationMs)", () => {
    it("populates durationMs as a finite non-negative number across fixtures", () => {
      const result = suggestTags("PHY 110 - Physics", "Problems in classical mechanics");
      assert.strictEqual(typeof result.durationMs, "number");
      assert.strictEqual(Number.isNaN(result.durationMs), false);
      assert.strictEqual(Number.isFinite(result.durationMs), true);
      assert.ok(result.durationMs >= 0);
    });
  });

  describe("Taxonomy alignment", () => {
    it("suggests tags that align with canonical taxonomy subjects or aliases", () => {
      const taxonomy = getTaxonomy();
      const pool = getTagPool();
      assert.ok(Array.isArray(pool));
      assert.ok(pool.length > 0);

      const poolLower = pool.map(t => t.toLowerCase());
      for (const subject of taxonomy.subjects) {
        assert.ok(poolLower.includes(subject.label.toLowerCase()));
      }

      const result = suggestTags("Differential Calculus Notes", "Derivatives and integrals");
      const lowerTags = result.tags.map(t => t.toLowerCase());
      assert.ok(lowerTags.some(t => t === "math" || t === "calculus" || t === "mathematics"));
    });
  });
});
