import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { evaluateReleaseReadiness } from "../../src/lib/release/readiness.js";

const NOW = new Date("2026-10-15T12:00:00Z");
const COMMIT = "a".repeat(40);

const passingEvidence = (overrides = {}) => ({
  release: "v0.2.0",
  commit: COMMIT,
  generatedAt: "2026-10-14T10:00:00Z",
  migrations: [{ id: "add_notification_preferences_001", status: "applied", dryRunPassed: true, rollbackDocumented: true }],
  securityChecks: { dependencyAudit: "passed", secretScan: "passed" },
  smokeTests: { status: "passed" },
  rollbackRehearsal: { status: "passed", rehearsedAt: "2026-10-10T16:00:00Z", restoredToCommit: "b".repeat(40) },
  ...overrides,
});

const evaluate = (evidence, options = {}) => evaluateReleaseReadiness(evidence, { now: NOW, expectedCommit: COMMIT, ...options });
const blockedGates = (result) => result.blockers.map((b) => b.gate);

describe("evaluateReleaseReadiness", () => {
  test("ready when every gate passes for this commit", () => {
    const result = evaluate(passingEvidence());
    assert.equal(result.ready, true);
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(result.passed, ["evidence", "migrations", "security_checks", "smoke_tests", "rollback_rehearsal"]);
  });

  test("missing evidence blocks the release", () => {
    const result = evaluate(null);
    assert.equal(result.ready, false);
    assert.deepEqual(blockedGates(result), ["evidence"]);
  });

  test("evidence for a different commit blocks the release", () => {
    const result = evaluate(passingEvidence({ commit: "c".repeat(40) }));
    assert.equal(result.ready, false);
    assert.match(result.blockers[0].message, /is for commit/);
  });

  test("stale evidence blocks the release", () => {
    const result = evaluate(passingEvidence({ generatedAt: "2026-09-01T00:00:00Z" }));
    assert.equal(blockedGates(result).includes("evidence"), true);
  });

  test("a pending migration blocks the release", () => {
    const result = evaluate(passingEvidence({
      migrations: [{ id: "backfill_x", status: "pending" }],
    }));
    assert.deepEqual(blockedGates(result), ["migrations"]);
    assert.match(result.blockers[0].message, /still pending/);
  });

  test("an applied migration without a dry run or documented rollback blocks", () => {
    const result = evaluate(passingEvidence({
      migrations: [{ id: "backfill_x", status: "applied", dryRunPassed: true }],
    }));
    assert.deepEqual(blockedGates(result), ["migrations"]);
  });

  test("an empty migrations list is an explicit pass", () => {
    assert.equal(evaluate(passingEvidence({ migrations: [] })).ready, true);
  });

  test("a missing migrations field blocks rather than defaulting to pass", () => {
    const { migrations: _omit, ...evidence } = passingEvidence();
    assert.deepEqual(blockedGates(evaluate(evidence)), ["migrations"]);
  });

  test("a failed or missing security check blocks the release", () => {
    const result = evaluate(passingEvidence({ securityChecks: { dependencyAudit: "passed", secretScan: "failed" } }));
    assert.deepEqual(blockedGates(result), ["security_checks"]);
    assert.match(result.blockers[0].message, /secretScan=failed/);
  });

  test("smoke tests that did not run block the release", () => {
    assert.deepEqual(blockedGates(evaluate(passingEvidence({ smokeTests: { status: "not_run" } }))), ["smoke_tests"]);
  });

  test("a rollback rehearsal must name the restored commit and be recent", () => {
    const noTarget = evaluate(passingEvidence({ rollbackRehearsal: { status: "passed", rehearsedAt: "2026-10-10T16:00:00Z" } }));
    assert.deepEqual(blockedGates(noTarget), ["rollback_rehearsal"]);

    const old = evaluate(passingEvidence({
      rollbackRehearsal: { status: "passed", rehearsedAt: "2026-07-01T00:00:00Z", restoredToCommit: "b".repeat(40) },
    }));
    assert.deepEqual(blockedGates(old), ["rollback_rehearsal"]);
  });

  test("every failing gate is reported together, not just the first", () => {
    const result = evaluate(passingEvidence({
      migrations: [{ id: "x", status: "pending" }],
      smokeTests: { status: "failed" },
    }));
    assert.deepEqual(blockedGates(result), ["migrations", "smoke_tests"]);
  });
});
