// #978: release readiness gate. A release is ready only when the evidence file
// proves every gate passed for the exact commit being released. Missing,
// incomplete, stale, or mismatched evidence blocks the release. Nothing here
// runs migrations or deploys anything; it only reads the evidence.

export const MIGRATION_STATUSES = Object.freeze(["applied", "not_required", "pending"]);
export const CHECK_STATUSES = Object.freeze(["passed", "failed", "not_run"]);

const DAY_MS = 24 * 60 * 60 * 1000;

function parseTime(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function block(gate, message) {
  return { gate, message };
}

/**
 * @param {object|null} evidence  parsed contents of release/readiness.json
 * @param {object} [options]
 * @param {string} [options.expectedCommit]   the commit being released (CI passes GITHUB_SHA)
 * @param {Date}   [options.now]
 * @param {number} [options.maxEvidenceAgeDays=14]
 * @param {number} [options.maxRehearsalAgeDays=30]
 * @returns {{ ready: boolean, passed: string[], blockers: Array<{gate: string, message: string}> }}
 */
export function evaluateReleaseReadiness(evidence, {
  expectedCommit = null,
  now = new Date(),
  maxEvidenceAgeDays = 14,
  maxRehearsalAgeDays = 30,
} = {}) {
  if (!evidence || typeof evidence !== "object") {
    return { ready: false, passed: [], blockers: [block("evidence", "Release evidence file is missing or is not a JSON object")] };
  }

  const blockers = [];
  const passed = [];
  const nowMs = now.getTime();

  // ── envelope: which release, which commit, and how fresh ─────────────────
  const generatedAt = parseTime(evidence.generatedAt);
  if (!evidence.release || !evidence.commit || generatedAt === null) {
    blockers.push(block("evidence", "Evidence must include release, commit, and a valid generatedAt"));
  } else if (expectedCommit && evidence.commit !== expectedCommit) {
    blockers.push(block("evidence", `Evidence is for commit ${evidence.commit}, but the release is ${expectedCommit}`));
  } else if (nowMs - generatedAt > maxEvidenceAgeDays * DAY_MS) {
    blockers.push(block("evidence", `Evidence is older than ${maxEvidenceAgeDays} days. Regenerate it for this release`));
  } else {
    passed.push("evidence");
  }

  // ── migrations: every migration must be applied (with a dry run and a
  // documented rollback) or explicitly not required. An empty list is an
  // explicit "no migrations this release".
  if (!Array.isArray(evidence.migrations)) {
    blockers.push(block("migrations", "migrations must be an array, use [] when a release has none"));
  } else {
    const problems = [];
    for (const migration of evidence.migrations) {
      const id = migration?.id || "(unnamed)";
      if (!MIGRATION_STATUSES.includes(migration?.status)) {
        problems.push(`${id}: status must be one of ${MIGRATION_STATUSES.join(", ")}`);
      } else if (migration.status === "pending") {
        problems.push(`${id}: still pending`);
      } else if (migration.status === "applied" && (migration.dryRunPassed !== true || migration.rollbackDocumented !== true)) {
        problems.push(`${id}: applied migrations need dryRunPassed and rollbackDocumented set to true`);
      }
    }
    if (problems.length > 0) blockers.push(block("migrations", problems.join("; ")));
    else passed.push("migrations");
  }

  // ── security checks: dependency audit and secret scan both passed ─────────
  const security = evidence.securityChecks || {};
  const failedChecks = ["dependencyAudit", "secretScan"]
    .filter((check) => security[check] !== "passed")
    .map((check) => `${check}=${security[check] ?? "missing"}`);
  if (failedChecks.length > 0) {
    blockers.push(block("security_checks", `Security checks must all be "passed": ${failedChecks.join(", ")}`));
  } else {
    passed.push("security_checks");
  }

  // ── smoke tests against the release candidate ────────────────────────────
  if (evidence.smokeTests?.status !== "passed") {
    blockers.push(block("smoke_tests", `smokeTests.status must be "passed", got "${evidence.smokeTests?.status ?? "missing"}"`));
  } else {
    passed.push("smoke_tests");
  }

  // ── rollback rehearsal: a recent, successful restore to a known commit ───
  const rehearsal = evidence.rollbackRehearsal || {};
  const rehearsedAt = parseTime(rehearsal.rehearsedAt);
  if (rehearsal.status !== "passed") {
    blockers.push(block("rollback_rehearsal", `rollbackRehearsal.status must be "passed", got "${rehearsal.status ?? "missing"}"`));
  } else if (!rehearsal.restoredToCommit) {
    blockers.push(block("rollback_rehearsal", "A rollback rehearsal must name restoredToCommit, the known-good commit it returned to"));
  } else if (rehearsedAt === null || nowMs - rehearsedAt > maxRehearsalAgeDays * DAY_MS) {
    blockers.push(block("rollback_rehearsal", `Rollback rehearsal must be dated within the last ${maxRehearsalAgeDays} days`));
  } else {
    passed.push("rollback_rehearsal");
  }

  return { ready: blockers.length === 0, passed, blockers };
}
