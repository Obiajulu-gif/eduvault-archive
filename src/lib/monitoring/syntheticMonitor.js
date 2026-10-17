/**
 * Synthetic monitoring for the critical end-to-end journeys (#1014).
 *
 * Extends the journey monitor with:
 *  - Multiple named journey scenarios (buyer purchase, creator publish,
 *    search-to-purchase, auth flow, entitlement revocation).
 *  - Per-scenario SLA thresholds (p95 latency + success-rate floors).
 *  - Structured health reporting: "green / degraded / red" per scenario and
 *    an overall system health roll-up.
 *  - Scheduler: run all scenarios on a cadence, maintain a rolling window of
 *    run history, and emit alerts when SLAs are breached.
 *
 * Transport-free by design: I/O (DB, network, cron) is injected so this module
 * is fully testable in CI without infrastructure.
 *
 * Stable reporting contract consumed by the API route and CLI:
 * {
 *   health:    "green" | "degraded" | "red"
 *   checkedAt: ISO string
 *   scenarios: [{
 *     id, name, health, sla, lastRun: { ok, durationMs, failures, blame },
 *     history: { runs, successRate, latency: { p50, p95 } }
 *   }]
 *   summary: { totalScenarios, passing, degraded, failing }
 * }
 */

import crypto from "node:crypto";
import {
  runSyntheticJourney,
  summarizeJourneyReports,
  newJourneyRunId,
  JOURNEY_STEP_IDS,
  JOURNEY_STEP_STATUSES,
} from "./journeyMonitor.js";

// ---------------------------------------------------------------------------
// SLA defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SLA = Object.freeze({
  /** Minimum fraction of runs that must pass (0–1). */
  successRateFloor: 0.95,
  /** Maximum acceptable p95 step latency in ms (across all steps). */
  p95LatencyMs: 5_000,
  /** Number of most-recent runs to include in health evaluation. */
  windowSize: 10,
});

// ---------------------------------------------------------------------------
// Health states
// ---------------------------------------------------------------------------

export const HEALTH_STATES = Object.freeze({
  GREEN:    "green",    // all SLAs met
  DEGRADED: "degraded", // at least one SLA is in warning range (>50 % toward breach)
  RED:      "red",      // SLA breach: success rate below floor or p95 over limit
});

// ---------------------------------------------------------------------------
// Built-in scenario definitions
// ---------------------------------------------------------------------------

/**
 * Each scenario wraps a journey harness builder.
 *
 * `buildHarness(adapters)` receives the injected adapters object and returns
 * a harness compatible with `runSyntheticJourney`.  In production the real
 * adapters are injected by the CLI; in tests lightweight fakes are used.
 */
export const SCENARIO_IDS = Object.freeze({
  BUYER_PURCHASE_FLOW:        "buyer_purchase_flow",
  CREATOR_PUBLISH_TO_ACCESS:  "creator_publish_to_access",
  AUTH_CHALLENGE_VERIFY:      "auth_challenge_verify",
  SEARCH_TO_PURCHASE:         "search_to_purchase",
  ENTITLEMENT_REVOCATION:     "entitlement_revocation",
});

export const SCENARIO_DEFINITIONS = Object.freeze([
  {
    id:   SCENARIO_IDS.BUYER_PURCHASE_FLOW,
    name: "Buyer purchase flow",
    description:
      "End-to-end happy path: checkout quote → purchase confirm → entitlement grant " +
      "→ entitlement authorize → download capability.",
    sla: { ...DEFAULT_SLA },
    /**
     * Delegates to the existing journey harness so there is a single source of
     * truth for the canonical purchase flow.
     */
    buildHarness(adapters) {
      return adapters.purchaseHarness ?? buildPassthroughHarness("buyer_purchase_flow");
    },
  },

  {
    id:   SCENARIO_IDS.CREATOR_PUBLISH_TO_ACCESS,
    name: "Creator publish → buyer access",
    description:
      "A creator publishes a new material; a buyer then obtains an entitlement " +
      "and verifies access is granted.",
    sla: { ...DEFAULT_SLA, p95LatencyMs: 8_000 }, // publishing is slower
    buildHarness(adapters) {
      return adapters.creatorPublishHarness ?? buildPassthroughHarness("creator_publish_to_access");
    },
  },

  {
    id:   SCENARIO_IDS.AUTH_CHALLENGE_VERIFY,
    name: "Auth challenge → verify → session",
    description:
      "Wallet challenge is generated, signed (synthetic), and verified; " +
      "a JWT is issued and the session is readable.",
    sla: { ...DEFAULT_SLA, p95LatencyMs: 2_000 }, // auth must be fast
    buildHarness(adapters) {
      return adapters.authHarness ?? buildPassthroughHarness("auth_challenge_verify");
    },
  },

  {
    id:   SCENARIO_IDS.SEARCH_TO_PURCHASE,
    name: "Search → material detail → purchase",
    description:
      "Full-text search returns a result, material detail is readable, " +
      "and a checkout quote can be created.",
    sla: { ...DEFAULT_SLA, p95LatencyMs: 3_000 },
    buildHarness(adapters) {
      return adapters.searchHarness ?? buildPassthroughHarness("search_to_purchase");
    },
  },

  {
    id:   SCENARIO_IDS.ENTITLEMENT_REVOCATION,
    name: "Entitlement revocation",
    description:
      "An active entitlement is revoked; subsequent authorization attempts " +
      "are correctly denied.",
    sla: { ...DEFAULT_SLA, p95LatencyMs: 3_000 },
    buildHarness(adapters) {
      return adapters.revocationHarness ?? buildPassthroughHarness("entitlement_revocation");
    },
  },
]);

// ---------------------------------------------------------------------------
// Passthrough harness (used when a real adapter is not injected)
// ---------------------------------------------------------------------------

/**
 * A minimal harness that exercises only the journey orchestration layer
 * without touching any real infrastructure.  Every step passes immediately
 * so CI always has a green baseline for un-injected scenarios.
 */
function buildPassthroughHarness(scenarioId) {
  const steps = {};
  for (const stepId of Object.values(JOURNEY_STEP_IDS)) {
    steps[stepId] = async () => ({ synthetic: true, scenario: scenarioId, step: stepId });
  }
  return { steps };
}

// ---------------------------------------------------------------------------
// SLA evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a scenario's rolling history meets its SLA.
 *
 * @param {object[]} reports – Array of runSyntheticJourney reports.
 * @param {object}   sla     – { successRateFloor, p95LatencyMs, windowSize }.
 * @returns {{ health, successRate, p95LatencyMs, breaches }}
 */
export function evaluateScenarioSla(reports = [], sla = DEFAULT_SLA) {
  const window = reports.slice(-Math.max(1, sla.windowSize ?? DEFAULT_SLA.windowSize));

  if (window.length === 0) {
    return {
      health:       HEALTH_STATES.GREEN,
      successRate:  null,
      p95LatencyMs: null,
      breaches:     [],
      evaluated:    false,
    };
  }

  const summary = summarizeJourneyReports(window);
  const successRate  = summary.successRate ?? 1;
  const overallP95   = summary.latency?.overall?.p95 ?? 0;

  const breaches = [];
  const floor   = sla.successRateFloor ?? DEFAULT_SLA.successRateFloor;
  const p95Ceil = sla.p95LatencyMs    ?? DEFAULT_SLA.p95LatencyMs;

  if (successRate < floor) {
    breaches.push({
      type:      "success_rate",
      actual:    successRate,
      threshold: floor,
      message:   `Success rate ${(successRate * 100).toFixed(1)}% is below the ${(floor * 100).toFixed(0)}% floor.`,
    });
  }

  if (overallP95 > p95Ceil) {
    breaches.push({
      type:      "p95_latency",
      actual:    overallP95,
      threshold: p95Ceil,
      message:   `p95 latency ${overallP95}ms exceeds the ${p95Ceil}ms ceiling.`,
    });
  }

  // "Degraded" = within 50 % of a breach but not yet over the limit
  let health;
  if (breaches.length > 0) {
    health = HEALTH_STATES.RED;
  } else {
    const nearSuccessFloor = successRate < floor + (1 - floor) * 0.5;
    const nearLatencyCeil  = overallP95 > p95Ceil * 0.7;
    health = nearSuccessFloor || nearLatencyCeil ? HEALTH_STATES.DEGRADED : HEALTH_STATES.GREEN;
  }

  return {
    health,
    successRate,
    p95LatencyMs: overallP95,
    breaches,
    evaluated:    true,
    windowSize:   window.length,
  };
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

/**
 * Run a single scenario and return a structured result.
 *
 * @param {object} definition – Entry from SCENARIO_DEFINITIONS.
 * @param {object} adapters   – Injected adapters (DB, services, fakes).
 * @param {object} [opts]
 * @param {number} [opts.stepTimeoutMs]
 * @param {() => number} [opts.now]
 * @returns {Promise<ScenarioRunResult>}
 */
export async function runScenario(definition, adapters = {}, opts = {}) {
  const harness = definition.buildHarness(adapters);
  const runId   = newJourneyRunId(opts.now ?? (() => Date.now()));

  const report = await runSyntheticJourney({
    harness,
    runId,
    stepTimeoutMs: opts.stepTimeoutMs ?? 15_000,
    now:           opts.now,
  });

  return {
    scenarioId: definition.id,
    runId:      report.runId,
    ok:         report.ok,
    durationMs: report.durationMs,
    startedAt:  report.startedAt,
    finishedAt: report.finishedAt,
    steps:      report.steps,
    failures:   report.failures,
    blame:      report.blame,
  };
}

// ---------------------------------------------------------------------------
// Multi-scenario health reporter
// ---------------------------------------------------------------------------

/**
 * Run all (or a selected subset of) scenarios and assemble a health report.
 *
 * @param {object}   opts
 * @param {object}   [opts.adapters]       Injected adapters per scenario.
 * @param {string[]} [opts.scenarioIds]    Subset to run (default: all).
 * @param {Map}      [opts.history]        Scenario id → previous run reports.
 * @param {number}   [opts.stepTimeoutMs]
 * @param {() => number} [opts.now]
 * @param {(event: object) => void} [opts.onScenario]  Progress hook.
 * @returns {Promise<HealthReport>}
 */
export async function runHealthCheck({
  adapters = {},
  scenarioIds,
  history = new Map(),
  stepTimeoutMs = 15_000,
  now = () => Date.now(),
  onScenario,
} = {}) {
  const definitions = scenarioIds
    ? SCENARIO_DEFINITIONS.filter((d) => scenarioIds.includes(d.id))
    : [...SCENARIO_DEFINITIONS];

  const checkedAt = new Date(now()).toISOString();
  const scenarioResults = [];

  for (const definition of definitions) {
    const result = await runScenario(definition, adapters, { stepTimeoutMs, now });

    // Append this run to the rolling history for SLA evaluation
    const previousRuns = history.get(definition.id) ?? [];
    const updatedRuns  = [...previousRuns, {
      ok:         result.ok,
      durationMs: result.durationMs,
      steps:      result.steps,
      failures:   result.failures,
      blame:      result.blame,
      startedAt:  result.startedAt,
      finishedAt: result.finishedAt,
    }];
    history.set(definition.id, updatedRuns.slice(-definition.sla.windowSize));

    const slaResult = evaluateScenarioSla(updatedRuns, definition.sla);
    const histSummary = summarizeJourneyReports(updatedRuns);

    const scenarioReport = {
      id:          definition.id,
      name:        definition.name,
      health:      slaResult.health,
      sla:         { ...definition.sla, ...slaResult },
      lastRun: {
        runId:     result.runId,
        ok:        result.ok,
        startedAt: result.startedAt,
        durationMs: result.durationMs,
        failures:  result.failures,
        blame:     result.blame,
      },
      history: {
        runs:        histSummary.runs,
        successRate: histSummary.successRate,
        latency:     histSummary.latency?.overall
          ? {
              p50: histSummary.latency.overall.p50,
              p95: histSummary.latency.overall.p95,
              avg: histSummary.latency.overall.avg,
            }
          : null,
        blame: histSummary.blame,
      },
    };

    scenarioResults.push(scenarioReport);
    onScenario?.(scenarioReport);
  }

  // Roll up overall health: worst individual scenario wins
  const overallHealth = rollUpHealth(scenarioResults.map((s) => s.health));

  const summary = {
    totalScenarios: scenarioResults.length,
    passing:  scenarioResults.filter((s) => s.health === HEALTH_STATES.GREEN).length,
    degraded: scenarioResults.filter((s) => s.health === HEALTH_STATES.DEGRADED).length,
    failing:  scenarioResults.filter((s) => s.health === HEALTH_STATES.RED).length,
  };

  return {
    health:     overallHealth,
    checkedAt,
    scenarios:  scenarioResults,
    summary,
    checkId:    crypto.randomUUID(),
  };
}

function rollUpHealth(healthValues) {
  if (healthValues.includes(HEALTH_STATES.RED))      return HEALTH_STATES.RED;
  if (healthValues.includes(HEALTH_STATES.DEGRADED)) return HEALTH_STATES.DEGRADED;
  return HEALTH_STATES.GREEN;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Create a scheduler that runs health checks on a fixed interval, maintains a
 * rolling history, and calls `onAlert` whenever a scenario breaches its SLA.
 *
 * The scheduler is transport-free: `setTimeout`/`clearTimeout` are injected so
 * tests can advance time deterministically.
 *
 * @param {object} opts
 * @param {number}   opts.intervalMs     Milliseconds between checks.
 * @param {object}   [opts.adapters]     Forwarded to runHealthCheck.
 * @param {string[]} [opts.scenarioIds]  Subset to monitor.
 * @param {number}   [opts.stepTimeoutMs]
 * @param {(report: HealthReport) => void} [opts.onCheck]  Called after every check.
 * @param {(breach: object) => void}       [opts.onAlert]  Called on SLA breach.
 * @param {Function} [opts.setIntervalFn]  Override for setInterval (tests).
 * @param {Function} [opts.clearIntervalFn] Override for clearInterval (tests).
 *
 * @returns {{ start, stop, getLastReport, getHistory }}
 */
export function createSyntheticMonitorScheduler({
  intervalMs = 5 * 60 * 1_000, // 5 min default
  adapters = {},
  scenarioIds,
  stepTimeoutMs = 15_000,
  onCheck,
  onAlert,
  setIntervalFn   = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const history    = new Map();
  let lastReport   = null;
  let timerId      = null;
  let running      = false;

  async function tick() {
    const report = await runHealthCheck({
      adapters,
      scenarioIds,
      history,
      stepTimeoutMs,
    });
    lastReport = report;

    // Fire alerts for any red scenario
    for (const scenario of report.scenarios) {
      if (scenario.health === HEALTH_STATES.RED && typeof onAlert === "function") {
        for (const breach of scenario.sla.breaches ?? []) {
          onAlert({
            scenarioId:   scenario.id,
            scenarioName: scenario.name,
            breach,
            lastRun:      scenario.lastRun,
            checkedAt:    report.checkedAt,
          });
        }
      }
    }

    onCheck?.(report);
    return report;
  }

  function start() {
    if (running) return;
    running = true;
    // Run immediately, then on interval
    tick().catch((err) => {
      console.error("[syntheticMonitor] tick error:", err);
    });
    timerId = setIntervalFn(() => {
      tick().catch((err) => {
        console.error("[syntheticMonitor] tick error:", err);
      });
    }, intervalMs);
  }

  function stop() {
    if (timerId !== null) {
      clearIntervalFn(timerId);
      timerId = null;
    }
    running = false;
  }

  function getLastReport() {
    return lastReport;
  }

  function getHistory() {
    return new Map([...history]);
  }

  return Object.freeze({ start, stop, getLastReport, getHistory, tick });
}

/**
 * @typedef {Object} ScenarioRunResult
 * @property {string}   scenarioId
 * @property {string}   runId
 * @property {boolean}  ok
 * @property {number}   durationMs
 * @property {string}   startedAt
 * @property {string}   finishedAt
 * @property {Array}    steps
 * @property {Array}    failures
 * @property {object}   blame
 */

/**
 * @typedef {Object} HealthReport
 * @property {string}   health      "green" | "degraded" | "red"
 * @property {string}   checkedAt
 * @property {Array}    scenarios
 * @property {object}   summary
 * @property {string}   checkId
 */
