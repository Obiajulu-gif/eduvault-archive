// #978: release readiness gate. A release is ready only when the evidence file
// proves every gate passed for the exact commit being released. Missing,
// incomplete, stale, or mismatched evidence blocks the release. Nothing here
// runs migrations or deploys anything; it only reads the evidence.

export const MIGRATION_STATUSES = Object.freeze(["applied", "not_required", "pending"]);
export const CHECK_STATUSES = Object.freeze(["passed", "failed", "not_run"]);

const DAY_MS = 24 * 60 * 60 * 1000;
// Evidence dated later than this is rejected: a future date would never go stale.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
// The evidence file is committed in the release, so it can never name that
// commit's own SHA. A release commit whose only changes since the evidenced
// commit are under release/ still ships exactly the evidenced code.
const EVIDENCE_DIR = "release/";
// The VerificationStatus.VERIFIED result of `npm run verify:rollback`
// (src/lib/migrations/rollbackVerification.js), kept literal so this gate has no imports.
const ROLLBACK_VERIFIED = "verified";

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
 * @param {string} [options.expectedCommit]   the commit being released (CI passes the tag or PR head SHA)
 * @param {string[]|null} [options.changedFilesSinceEvidence]  `git diff --name-only <evidence.commit> <expectedCommit>`,
 *   or null when unknown. Lets a release commit that only adds evidence pass.
 * @param {Date}   [options.now]
 * @param {number} [options.maxEvidenceAgeDays=14]
 * @param {number} [options.maxRehearsalAgeDays=30]
 * @returns {{ ready: boolean, passed: string[], blockers: Array<{gate: string, message: string}> }}
 */
export function evaluateReleaseReadiness(evidence, {
  expectedCommit = null,
  changedFilesSinceEvidence = null,
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
  const codeChanges = Array.isArray(changedFilesSinceEvidence)
    ? changedFilesSinceEvidence.filter((file) => !String(file).startsWith(EVIDENCE_DIR))
    : null;
  if (!evidence.release || !evidence.commit || generatedAt === null) {
    blockers.push(block("evidence", "Evidence must include release, commit, and a valid generatedAt"));
  } else if (expectedCommit && evidence.commit !== expectedCommit && codeChanges?.length !== 0) {
    const detail = codeChanges ? `; files changed since the evidence: ${codeChanges.slice(0, 5).join(", ")}` : "";
    blockers.push(block("evidence", `Evidence is for commit ${evidence.commit}, but the release is ${expectedCommit}${detail}`));
  } else if (generatedAt - nowMs > MAX_CLOCK_SKEW_MS) {
    blockers.push(block("evidence", "generatedAt is in the future. Use the time the evidence was produced"));
  } else if (nowMs - generatedAt > maxEvidenceAgeDays * DAY_MS) {
    blockers.push(block("evidence", `Evidence is older than ${maxEvidenceAgeDays} days. Regenerate it for this release`));
  } else {
    passed.push("evidence");
  }

  // ── migrations: every migration must be applied (with a dry run, a
  // documented rollback and a verified rollback rehearsal) or explicitly not
  // required. An empty list is an explicit "no migrations this release".
  if (!Array.isArray(evidence.migrations)) {
    blockers.push(block("migrations", "migrations must be an array, use [] when a release has none"));
  } else {
    const problems = [];
    const seenIds = new Set();
    for (const migration of evidence.migrations) {
      const id = typeof migration?.id === "string" ? migration.id.trim() : "";
      if (!id) {
        problems.push("every migration needs a non-empty id");
      } else if (seenIds.has(id)) {
        problems.push(`${id}: listed more than once`);
      } else if (!MIGRATION_STATUSES.includes(migration.status)) {
        problems.push(`${id}: status must be one of ${MIGRATION_STATUSES.join(", ")}`);
      } else if (migration.status === "pending") {
        problems.push(`${id}: still pending`);
      } else if (migration.status === "applied" && (migration.dryRunPassed !== true || migration.rollbackDocumented !== true)) {
        problems.push(`${id}: applied migrations need dryRunPassed and rollbackDocumented set to true`);
      } else if (migration.status === "applied" && migration.rollbackVerification !== ROLLBACK_VERIFIED) {
        problems.push(`${id}: applied migrations need rollbackVerification "${ROLLBACK_VERIFIED}" from npm run verify:rollback`);
      }
      if (id) seenIds.add(id);
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
  } else if (rehearsal.restoredToCommit === evidence.commit) {
    blockers.push(block("rollback_rehearsal", "restoredToCommit is the release candidate itself; a rehearsal must return to an earlier known-good commit"));
  } else if (rehearsedAt === null || nowMs - rehearsedAt > maxRehearsalAgeDays * DAY_MS || rehearsedAt - nowMs > MAX_CLOCK_SKEW_MS) {
    blockers.push(block("rollback_rehearsal", `Rollback rehearsal must be dated within the last ${maxRehearsalAgeDays} days and not in the future`));
  } else {
    passed.push("rollback_rehearsal");
  }

  return { ready: blockers.length === 0, passed, blockers };
}
