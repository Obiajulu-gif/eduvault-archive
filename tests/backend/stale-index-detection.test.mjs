import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  detectSearchIndexDrift,
  detectStaleCacheKeys,
  recommendRepairs,
  summarizeFindings,
} from "../../src/lib/backend/staleIndexDetection.js";

const publicMaterial = (id, updatedAt = new Date(1_000)) => ({
  _id: id,
  title: `Material ${id}`,
  visibility: "public",
  updatedAt,
});

describe("detectSearchIndexDrift", () => {
  test("flags a searchable material with no projection as missing", () => {
    const findings = detectSearchIndexDrift({ materials: [publicMaterial("m1")], projections: [] });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, "missing");
    assert.equal(findings[0].materialId, "m1");
  });

  test("flags a projection behind the material version as stale", () => {
    const findings = detectSearchIndexDrift({
      materials: [publicMaterial("m1", new Date(5_000))],
      projections: [{ _id: "m1", projectionVersion: 2_000 }],
    });
    assert.deepEqual(findings.map((f) => f.type), ["stale"]);
    assert.equal(findings[0].expectedVersion, 5_000);
    assert.equal(findings[0].actualVersion, 2_000);
  });

  test("flags a projection that exposes a now-private material as unauthorized", () => {
    const findings = detectSearchIndexDrift({
      materials: [{ ...publicMaterial("m1"), visibility: "private" }],
      projections: [{ _id: "m1", projectionVersion: 1_000 }],
    });
    assert.deepEqual(findings.map((f) => f.type), ["unauthorized"]);
  });

  test("flags a projection with no source material as orphan", () => {
    const findings = detectSearchIndexDrift({
      materials: [],
      projections: [{ _id: "gone", projectionVersion: 9 }],
    });
    assert.equal(findings[0].type, "orphan");
    assert.equal(findings[0].reason, "projection_without_material");
  });

  test("ignores an up-to-date projection and an unsearchable material with no projection", () => {
    const findings = detectSearchIndexDrift({
      materials: [publicMaterial("m1"), { ...publicMaterial("m2"), visibility: "private" }],
      projections: [{ _id: "m1", projectionVersion: 1_000 }],
    });
    assert.deepEqual(findings, []);
  });
});

describe("detectStaleCacheKeys", () => {
  test("flags only catalog keys below the current revision", () => {
    const findings = detectStaleCacheKeys([
      "market-materials:v3:page=1",
      "market-materials:v5:page=1",
      "market-materials:v6:page=2",
      "some-other-key:v1",
    ], 5);
    assert.deepEqual(findings.map((f) => f.key), ["market-materials:v3:page=1"]);
    assert.equal(findings[0].type, "cache_generation_behind");
  });

  test("returns nothing when the current revision is unknown", () => {
    assert.deepEqual(detectStaleCacheKeys(["market-materials:v1:x"], undefined), []);
  });
});

describe("recommendRepairs and summarizeFindings", () => {
  test("automated, low-risk drift does not need an operator", () => {
    const summary = summarizeFindings([
      { type: "missing", materialId: "m1" },
      { type: "stale", materialId: "m2" },
    ]);
    assert.equal(summary.total, 2);
    assert.deepEqual(summary.byAction, { reindex_material: 2 });
    assert.equal(summary.requiresOperator, false);
  });

  test("exposure and orphans require an operator", () => {
    const summary = summarizeFindings([{ type: "unauthorized", materialId: "m1" }]);
    assert.equal(summary.requiresOperator, true);
    assert.equal(summary.byAction.remove_projection, 1);
  });

  test("unknown finding types are kept and sent for manual review", () => {
    const [annotated] = recommendRepairs([{ type: "something_new" }]);
    assert.equal(annotated.recommendation.action, "operator_review");
    assert.equal(annotated.recommendation.automated, false);
  });
});
