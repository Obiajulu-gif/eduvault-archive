/**
 * Synthetic journey monitor (#monitor): exercises the most valuable
 * end-to-end workflow — quote → purchase → entitlement → authorized access →
 * download capability — and reports latency, failures, and dependency blame.
 *
 * This module is intentionally transport-free: the CLI (`scripts/journey-monitor.mjs`)
 * injects the real Mongo/Stellar/entitlement adapters, and tests inject fakes.
 * That keeps the orchestration deterministic and runnable in CI without a
 * network while the scheduled production run exercises the real path.
 *
 * Reporting contract (stable — the CLI and alerting consume it):
 * {
 *   runId, ok, startedAt, finishedAt, durationMs,
 *   steps:    [{ id, name, dependency, status, startedAt, durationMs, detail, error }],
 *   failures: [{ stepId, dependency, code, message }],
 *   blame:    { primary, breakdown: [{ dependency, failures, stepIds }] }
 * }
 */

export const JOURNEY_STEP_IDS = Object.freeze({
  CHECKOUT_QUOTE: "checkout_quote",
  PURCHASE_CONFIRM: "purchase_confirm",
  ENTITLEMENT_GRANT: "entitlement_grant",
  ENTITLEMENT_AUTHORIZE: "entitlement_authorize",
  DOWNLOAD_CAPABILITY: "download_capability",
});

export const JOURNEY_STEP_STATUSES = Object.freeze({
  PASSED: "passed",
  FAILED: "failed",
  SKIPPED: "skipped",
});

/**
 * The critical happy path, in order. `dependency` names the first thing to
 * investigate when that step fails (the operator-facing "blame").
 */
export const JOURNEY_DEFINITION = Object.freeze([
  {
    id: JOURNEY_STEP_IDS.CHECKOUT_QUOTE,
    name: "Create checkout quote",
    dependency: "checkout-quotes",
  },
  {
    id: JOURNEY_STEP_IDS.PURCHASE_CONFIRM,
    name: "Confirm purchase",
    dependency: "mongodb:purchases",
  },
  {
    id: JOURNEY_STEP_IDS.ENTITLEMENT_GRANT,
    name: "Grant entitlement",
    dependency: "mongodb:entitlement_cache",
  },
  {
    id: JOURNEY_STEP_IDS.ENTITLEMENT_AUTHORIZE,
    name: "Authorize buyer access",
    dependency: "entitlement-policy",
  },
  {
    id: JOURNEY_STEP_IDS.DOWNLOAD_CAPABILITY,
    name: "Issue download capability",
    dependency: "download-capability",
  },
]);

const DEPENDENCY_PATTERNS = [
  // Most specific first: a quote error inside a Mongo transaction should
  // still blame the quote subsystem, not the driver.
  { dependency: "checkout-quotes", pattern: /quote/i },
  { dependency: "download-capability", pattern: /capability|signature mismatch|byte_range|nonce/i },
  { dependency: "mongodb", pattern: /MongoServerSelectionError|MongoNetworkError|MongoNotConnectedError|server selection|topology|ECONNREFUSED.*27017/i },
  { dependency: "stellar-rpc", pattern: /stellar|soroban|horizon|\brpc\b|insufficient[_ ]funds|bad_seq|tx_/i },
  { dependency: "ipfs-gateway", pattern: /ipfs|pinata|gateway|\bbafy|\bQm[1-9A-HJ-NP-Za-km-z]{6}/ },
  { dependency: "outbox", pattern: /outbox|intent|delivery/i },
];

/**
 * Map a thrown failure to the dependency it should be blamed on. An explicit
 * `error.dependency` always wins; otherwise known error text is classified;
 * finally the failing step's own declared dependency is used.
 */
export function classifyJourneyFailure(error, step) {
  const message = String(error?.message || error || "Unknown failure");
  const code = error?.code || "unknown_error";
  const explicit = typeof error?.dependency === "string" && error.dependency ? error.dependency : null;

  let dependency = explicit;
  if (!dependency) {
    for (const candidate of DEPENDENCY_PATTERNS) {
      if (candidate.pattern.test(message) || candidate.pattern.test(String(code))) {
        dependency = candidate.dependency;
        break;
      }
    }
  }
  if (!dependency) dependency = step?.dependency || "unknown";

  return {
    dependency,
    code,
    message: message.slice(0, 500),
    retryable: error?.retryable !== false && !/invalid|expired|not found/i.test(message),
  };
}

export function newJourneyRunId(now = () => Date.now()) {
  const random = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `journey-${now()}-${random}`;
}

class JourneyStepTimeoutError extends Error {
  constructor(stepId, timeoutMs) {
    super(`Journey step "${stepId}" timed out after ${timeoutMs}ms`);
    this.name = "JourneyStepTimeoutError";
    this.code = "journey_step_timeout";
  }
}

async function runStepWithTimeout(fn, step, timeoutMs, context) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fn(context);
  let timer;
  try {
    return await Promise.race([
      fn(context),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new JourneyStepTimeoutError(step.id, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} params
 * @param {{ steps: Record<string, (context) => any> }} params.harness
 *   One async function per `JOURNEY_DEFINITION` step id. Receives the running
 *   context: { runId, results, step }.
 * @param {string} [params.runId]
 * @param {() => number} [params.now]   Injectable clock for tests.
 * @param {number} [params.stepTimeoutMs] Per-step timeout (default 15s).
 * @param {(event: object) => void} [params.onStep] Progress observer for logging.
 */
export async function runSyntheticJourney({
  harness,
  runId = newJourneyRunId(),
  now = () => Date.now(),
  stepTimeoutMs = 15_000,
  onStep,
} = {}) {
  if (!harness || typeof harness.steps !== "object" || harness.steps === null) {
    throw new Error("runSyntheticJourney requires a harness with a steps map");
  }

  const startedAtMs = now();
  const steps = [];
  const results = {};
  let failed = false;

  for (const definition of JOURNEY_DEFINITION) {
    const stepFn = harness.steps[definition.id];
    const baseStep = {
      id: definition.id,
      name: definition.name,
      dependency: definition.dependency,
      detail: null,
      error: null,
    };

    if (failed) {
      const skipped = { ...baseStep, status: JOURNEY_STEP_STATUSES.SKIPPED, startedAt: null, durationMs: 0 };
      steps.push(skipped);
      onStep?.(skipped);
      continue;
    }

    if (typeof stepFn !== "function") {
      failed = true;
      const misconfigured = {
        ...baseStep,
        status: JOURNEY_STEP_STATUSES.FAILED,
        startedAt: new Date(startedAtMs).toISOString(),
        durationMs: 0,
        error: {
          dependency: definition.dependency,
          code: "harness_step_missing",
          message: `Harness has no implementation for step "${definition.id}"`,
        },
      };
      steps.push(misconfigured);
      onStep?.(misconfigured);
      continue;
    }

    const stepStarted = now();
    const startedAt = new Date(stepStarted).toISOString();
    try {
      const detail = await runStepWithTimeout(
        (context) => stepFn(context),
        definition,
        stepTimeoutMs,
        { runId, results, step: definition, now },
      );
      const completed = {
        ...baseStep,
        status: JOURNEY_STEP_STATUSES.PASSED,
        startedAt,
        durationMs: Math.max(0, now() - stepStarted),
        detail: detail === undefined ? null : detail,
      };
      results[definition.id] = completed.detail;
      steps.push(completed);
      onStep?.(completed);
    } catch (error) {
      failed = true;
      const completed = {
        ...baseStep,
        status: JOURNEY_STEP_STATUSES.FAILED,
        startedAt,
        durationMs: Math.max(0, now() - stepStarted),
        error: classifyJourneyFailure(error, definition),
      };
      steps.push(completed);
      onStep?.(completed);
    }
  }

  const finishedAtMs = now();
  const failures = steps
    .filter((step) => step.status === JOURNEY_STEP_STATUSES.FAILED)
    .map((step) => ({
      stepId: step.id,
      dependency: step.error.dependency,
      code: step.error.code,
      message: step.error.message,
    }));

  const blameCounts = new Map();
  for (const failure of failures) {
    const entry = blameCounts.get(failure.dependency) || { dependency: failure.dependency, failures: 0, stepIds: [] };
    entry.failures += 1;
    entry.stepIds.push(failure.stepId);
    blameCounts.set(failure.dependency, entry);
  }
  const breakdown = [...blameCounts.values()].sort((a, b) => b.failures - a.failures || a.dependency.localeCompare(b.dependency));

  const report = {
    runId,
    ok: failures.length === 0,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    steps,
    failures,
    blame: {
      primary: breakdown[0]?.dependency || null,
      breakdown,
    },
  };
  return report;
}

function percentile(sortedValues, fraction) {
  if (!sortedValues.length) return null;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(fraction * sortedValues.length) - 1));
  return sortedValues[index];
}

function latencyStats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(total / sorted.length),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

/**
 * Aggregate multiple run reports into success-rate + latency percentiles per
 * step, plus a dependency blame tally. Used by the scheduled CLI (`--runs=N`).
 */
export function summarizeJourneyReports(reports = []) {
  const perStep = new Map();
  const overallLatencies = [];
  let passed = 0;

  for (const report of reports) {
    if (report.ok) passed += 1;
    overallLatencies.push(report.durationMs);
    for (const step of report.steps) {
      const entry = perStep.get(step.id) || { id: step.id, name: step.name, dependency: step.dependency, statuses: {}, latencies: [] };
      entry.statuses[step.status] = (entry.statuses[step.status] || 0) + 1;
      if (step.status === JOURNEY_STEP_STATUSES.PASSED) entry.latencies.push(step.durationMs);
      perStep.set(step.id, entry);
    }
  }

  const blame = new Map();
  for (const report of reports) {
    for (const failure of report.failures) {
      blame.set(failure.dependency, (blame.get(failure.dependency) || 0) + 1);
    }
  }

  return {
    runs: reports.length,
    passed,
    failed: reports.length - passed,
    successRate: reports.length ? Number((passed / reports.length).toFixed(4)) : null,
    latency: {
      overall: latencyStats(overallLatencies),
      steps: Object.fromEntries(
        [...perStep.values()].map((entry) => [entry.id, { name: entry.name, dependency: entry.dependency, statuses: entry.statuses, latencyMs: latencyStats(entry.latencies) }]),
      ),
    },
    blame: [...blame.entries()]
      .map(([dependency, failures]) => ({ dependency, failures }))
      .sort((a, b) => b.failures - a.failures || a.dependency.localeCompare(b.dependency)),
  };
}
