// #1156: end-to-end check of the evidence gate's commit binding. Builds a
// throwaway git repo, commits evidence on top of the candidate, and runs the
// real CLI the release workflow runs.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve("scripts/release-readiness.mjs");
let repo;

const git = (...args) =>
  execFileSync("git", ["-c", "user.name=gate", "-c", "user.email=gate@example.com", ...args], { cwd: repo, encoding: "utf8" }).trim();

function commitFile(path, content, message) {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
  git("add", path);
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

function evidenceFor(commit, knownGood) {
  const now = new Date().toISOString();
  return JSON.stringify({
    release: "v9.9.9",
    commit,
    generatedAt: now,
    migrations: [{ id: "m1", status: "applied", dryRunPassed: true, rollbackDocumented: true, rollbackVerification: "verified" }],
    securityChecks: { dependencyAudit: "passed", secretScan: "passed" },
    smokeTests: { status: "passed" },
    rollbackRehearsal: { status: "passed", rehearsedAt: now, restoredToCommit: knownGood },
  });
}

function runGate(releaseCommit) {
  const result = spawnSync(process.execPath, [CLI, "--evidence", "release/readiness.json", "--commit", releaseCommit], { cwd: repo, encoding: "utf8" });
  return { code: result.status, report: result.stdout ? JSON.parse(result.stdout) : null };
}

describe("release evidence CLI commit binding (#1156)", () => {
  let knownGood;
  let candidate;

  before(() => {
    repo = mkdtempSync(join(tmpdir(), "release-gate-"));
    git("init", "-q");
    knownGood = commitFile("app.js", "v1\n", "known good");
    candidate = commitFile("app.js", "v2\n", "release candidate");
  });

  after(() => rmSync(repo, { recursive: true, force: true }));

  test("normal: a tag commit that only adds evidence for its parent passes", () => {
    const tagged = commitFile("release/readiness.json", evidenceFor(candidate, knownGood), "add evidence");
    const { code, report } = runGate(tagged);
    assert.equal(code, 0, JSON.stringify(report?.blockers));
    assert.equal(report.ready, true);
  });

  test("authorization: code changed after the evidence blocks and names the file", () => {
    const sneaked = commitFile("app.js", "v3\n", "change after evidence");
    const { code, report } = runGate(sneaked);
    assert.equal(code, 1);
    assert.match(report.blockers[0].message, /app\.js/);
  });

  test("a non-SHA commit value never reaches git as an option", () => {
    const tagged = commitFile("release/readiness.json", evidenceFor("--output=pwned.txt", knownGood), "bad evidence");
    const { code, report } = runGate(tagged);
    assert.equal(code, 1);
    assert.equal(report.blockers[0].gate, "evidence");
    assert.equal(existsSync(join(repo, "pwned.txt")), false);
  });
});
