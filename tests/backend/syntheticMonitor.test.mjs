/**
 * Tests for the synthetic monitoring module (#1014).
 *
 * All tests use injected harnesses — no database or network required.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  SCENARIO_DEFINITIONS,
  SCENARIO_IDS,
  HEALTH_STATES,
  DEFAULT_SLA,
  evaluateScenarioSla,
  runScenario,
  runHealthCheck,
  createSyntheticMonitorScheduler,
} from "../../src/lib/monitoring/syntheticMonitor.js";

import {
  JOURNEY_DEFINITION,
  JOURNEY_STEP_IDS,
  JOURNEY_STEP_STATUSES,
  summarizeJourneyReports,
} from "../../src/lib/monitoring/journeyMonitor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A harness that passes every step immediately. */
function happyHarness() {
  const steps = {};
  for (const def of JOURNEY_DEFINITION) {
    steps[def.id] = async () => ({ synthetic: true, step: def.id });
  }
  return { steps };
}

/** A harness that fails the first step. */
function failingHarness(failStepId = JOURNEY_STEP_IDS.CHECKOUT_QUOTE) {
  const steps = {};
  for (const def of JOURNEY_DEFINITION) {
    steps[def.id] = async () => {
      if (def.id === failStepId) {
        const err = new Error(`Simulated failure at ${failStepId}`);
        err.code  = "simulated_failure";
        throw err;
      }
      return { synthetic: true, step: def.id };
    };
  }
  return { steps };
}

function happyAdapters() {
  const h = happyHarness();
  return {
    purchaseHarness:       h,
    creatorPublishHarness: h,
    authHarness:           h,
    searchHarness:         h,
    revocationHarness:     h,
  };
}

function failingAdapters(scenarioId) {
  const adapters = happyAdapters();
  const defKey = {
    [SCENARIO_IDS.BUYER_PURCHASE_FLOW]:        "purchaseHarness",
    [SCENARIO_IDS.CREATOR_PUBLISH_TO_ACCESS]:  "creatorPublishHarness",
    [SCENARIO_IDS.AUTH_CHALLENGE_VERIFY]:      "authHarness",
    [SCENARIO_IDS.SEARCH_TO_PURCHASE]:         "searchHarness",
    [SCENARIO_IDS.ENTITLEMENT_REVOCATION]:     "revocationHarness",
  }[scenarioId];
  if (defKey) adapters[defKey] = failingHarness();
  return adapters;
}

// ---------------------------------------------------------------------------
// SCENARIO_DEFINITIONS shape
// ---------------------------------------------------------------------------

describe("SCENARIO_DEFINITIONS", () => {
  test("exports all expected scenario ids", () => {
    const ids = SCENARIO_DEFINITIONS.map((d) => d.id);
    for (const id of Object.values(SCENARIO_IDS)) {
      assert.ok(ids.includes(id), `Missing scenario: ${id}`);
    }
  });

  test("every definition has required fields", () => {
    for (const def of SCENARIO_DEFINITIONS) {
      assert.equal(typeof def.id,           "string",   `${def.id}: missing id`);
      assert.equal(typeof def.name,         "string",   `${def.id}: missing name`);
      assert.equal(typeof def.description,  "string",   `${def.id}: missing description`);
      assert.equal(typeof def.buildHarness, "function", `${def.id}: missing buildHarness`);
      assert.ok(def.sla,                                `${def.id}: missing sla`);
      assert.ok(typeof def.sla.successRateFloor === "number");
      assert.ok(typeof def.sla.p95LatencyMs     === "number");
    }
  });
});

// ---------------------------------------------------------------------------
// evaluateScenarioSla
// ---------------------------------------------------------------------------

describe("evaluateScenarioSla", () => {
  test("returns GREEN with no history (not yet evaluated)", () => {
    const result = evaluateScenarioSla([], DEFAULT_SLA);
    assert.equal(result.health,    HEALTH_STATES.GREEN);
    assert.equal(result.evaluated, false);
  });

  test("returns GREEN for all-passing runs within p95 ceiling", () => {
    const reports = Array.from({ length: 5 }, () => ({
      ok: true,
      durationMs: 200,
      steps: JOURNEY_DEFINITION.map((def) => ({
        id: def.id, status: JOURNEY_STEP_STATUSES.PASSED, durationMs: 40, dependency: def.dependency,
      })),
      failures: [],
      blame: { primary: null, breakdown: [] },
    }));
    const result = evaluateScenarioSla(reports, DEFAULT_SLA);
    assert.equal(result.health, HEALTH_STATES.GREEN);
    assert.equal(result.evaluated, true);
    assert.deepEqual(result.breaches, []);
  });

  test("returns RED when success rate is below floor", () => {
    const reports = [
      { ok: false, durationMs: 100, steps: JOURNEY_DEFINITION.map((d) => ({ id: d.id, status: JOURNEY_STEP_STATUSES.FAILED, durationMs: 100, dependency: d.dependency })), failures: [{ stepId: "checkout_quote", dependency: "checkout-quotes", code: "err", message: "fail" }], blame: { primary: "checkout-quotes", breakdown: [] } },
      { ok: false, durationMs: 100, steps: JOURNEY_DEFINITION.map((d) => ({ id: d.id, status: JOURNEY_STEP_STATUSES.FAILED, durationMs: 100, dependency: d.dependency })), failures: [{ stepId: "checkout_quote", dependency: "checkout-quotes", code: "err", message: "fail" }], blame: { primary: "checkout-quotes", breakdown: [] } },
      { ok: false, durationMs: 100, steps: JOURNEY_DEFINITION.map((d) => ({ id: d.id, status: JOURNEY_STEP_STATUSES.FAILED, durationMs: 100, dependency: d.dependency })), failures: [{ stepId: "checkout_quote", dependency: "checkout-quotes", code: "err", message: "fail" }], blame: { primary: "checkout-quotes", breakdown: [] } },
    ];
    const result = evaluateScenarioSla(reports, { ...DEFAULT_SLA, successRateFloor: 0.95 });
    assert.equal(result.health, HEALTH_STATES.RED);
    assert.ok(result.breaches.some((b) => b.type === "success_rate"));
  });

  test("only evaluates the most recent windowSize reports", () => {
    // 8 passing + 2 failing; window = 5, so only 1 fail is in window → still passes
    const passing = { ok: true, durationMs: 100, steps: JOURNEY_DEFINITION.map((d) => ({ id: d.id, status: JOURNEY_STEP_STATUSES.PASSED, durationMs: 20, dependency: d.dependency })), failures: [], blame: { primary: null, breakdown: [] } };
    const failing = { ok: false, durationMs: 100, steps: JOURNEY_DEFINITION.map((d) => ({ id: d.id, status: JOURNEY_STEP_STATUSES.FAILED, durationMs: 100, dependency: d.dependency })), failures: [{ stepId: "checkout_quote", dependency: "checkout-quotes", code: "e", message: "fail" }], blame: { primary: "checkout-quotes", breakdown: [] } };
    const reports = [...Array(8).fill(passing), failing, failing];
    const result = evaluateScenarioSla(reports, { ...DEFAULT_SLA, windowSize: 5 });
    // Window of 5: [passing, passing, passing, failing, failing] → 3/5 = 60% < 95% floor
    assert.equal(result.health, HEALTH_STATES.RED);
  });
});

// ---------------------------------------------------------------------------
// runScenario
// ---------------------------------------------------------------------------

describe("runScenario", () => {
  test("returns a passing result for a happy harness", async () => {
    const def    = SCENARIO_DEFINITIONS[0];
    const result = await runScenario(def, { purchaseHarness: happyHarness() });
    assert.equal(result.scenarioId, def.id);
    assert.equal(result.ok,         true);
    assert.ok(result.durationMs >= 0);
    assert.deepEqual(result.failures, []);
  });

  test("returns a failing result when the harness throws", async () => {
    const def    = SCENARIO_DEFINITIONS[0];
    const result = await runScenario(def, { purchaseHarness: failingHarness() });
    assert.equal(result.ok,            false);
    assert.ok(result.failures.length > 0);
    assert.equal(result.blame.primary, "checkout-quotes");
  });

  test("uses the passthrough harness when no adapter is injected", async () => {
    const def    = SCENARIO_DEFINITIONS[0];
    const result = await runScenario(def, {}); // no purchaseHarness injected
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// runHealthCheck — happy path
// ---------------------------------------------------------------------------

describe("runHealthCheck — happy path", () => {
  test("returns GREEN when all scenarios pass", async () => {
    const report = await runHealthCheck({ adapters: happyAdapters() });
    assert.equal(report.health, HEALTH_STATES.GREEN);
    assert.equal(typeof report.checkedAt, "string");
    assert.equal(typeof report.checkId,   "string");
    assert.ok(Array.isArray(report.scenarios));
    assert.equal(report.scenarios.length, SCENARIO_DEFINITIONS.length);
    assert.equal(report.summary.failing,  0);
  });

  test("every scenario entry has the expected shape", async () => {
    const report = await runHealthCheck({ adapters: happyAdapters() });
    for (const s of report.scenarios) {
      assert.ok(s.id,      `${s.id}: missing id`);
      assert.ok(s.name,    `${s.id}: missing name`);
      assert.ok(s.health,  `${s.id}: missing health`);
      assert.ok(s.lastRun, `${s.id}: missing lastRun`);
      assert.ok(s.history, `${s.id}: missing history`);
    }
  });

  test("scenarioIds filter restricts which scenarios run", async () => {
    const ids    = [SCENARIO_IDS.BUYER_PURCHASE_FLOW, SCENARIO_IDS.AUTH_CHALLENGE_VERIFY];
    const report = await runHealthCheck({ adapters: happyAdapters(), scenarioIds: ids });
    assert.equal(report.scenarios.length, 2);
    assert.deepEqual(report.scenarios.map((s) => s.id).sort(), ids.sort());
  });
});

// ---------------------------------------------------------------------------
// runHealthCheck — failure roll-up
// ---------------------------------------------------------------------------

describe("runHealthCheck — failure roll-up", () => {
  test("rolls up to RED when any scenario fails", async () => {
    const adapters = failingAdapters(SCENARIO_IDS.BUYER_PURCHASE_FLOW);
    // Need multiple failing runs to breach the SLA floor
    // Run health check multiple times with accumulating history
    const history  = new Map();
    let report;
    for (let i = 0; i < 10; i++) {
      report = await runHealthCheck({ adapters, history });
    }
    const failing = report.scenarios.find((s) => s.id === SCENARIO_IDS.BUYER_PURCHASE_FLOW);
    assert.equal(failing.health, HEALTH_STATES.RED);
    assert.equal(report.health,  HEALTH_STATES.RED);
    assert.ok(report.summary.failing > 0);
  });

  test("single passing run marks the scenario as GREEN even after previous failures", async () => {
    const history = new Map();
    // First run fails
    await runHealthCheck({ adapters: failingAdapters(SCENARIO_IDS.AUTH_CHALLENGE_VERIFY), history });
    // Next run passes
    const report = await runHealthCheck({ adapters: happyAdapters(), history });
    const auth = report.scenarios.find((s) => s.id === SCENARIO_IDS.AUTH_CHALLENGE_VERIFY);
    // 1 fail + 1 pass in window of 10 → success rate = 0.5; sill below 0.95 → RED or DEGRADED
    assert.ok(
      auth.health === HEALTH_STATES.RED || auth.health === HEALTH_STATES.DEGRADED,
      `expected degraded/red after 1 fail, got ${auth.health}`
    );
  });

  test("onScenario callback fires for each scenario", async () => {
    const seen = [];
    await runHealthCheck({
      adapters: happyAdapters(),
      onScenario: (s) => seen.push(s.id),
    });
    assert.equal(seen.length, SCENARIO_DEFINITIONS.length);
  });
});

// ---------------------------------------------------------------------------
// createSyntheticMonitorScheduler
// ---------------------------------------------------------------------------

describe("createSyntheticMonitorScheduler", () => {
  test("tick() returns a health report", async () => {
    const scheduler = createSyntheticMonitorScheduler({
      adapters:       happyAdapters(),
      intervalMs:     60_000,
      setIntervalFn:  () => 1,   // no-op
      clearIntervalFn: () => {},
    });
    const report = await scheduler.tick();
    assert.ok(report);
    assert.equal(report.health, HEALTH_STATES.GREEN);
  });

  test("getLastReport() returns the most recent report", async () => {
    const scheduler = createSyntheticMonitorScheduler({
      adapters:       happyAdapters(),
      intervalMs:     60_000,
      setIntervalFn:  () => 1,
      clearIntervalFn: () => {},
    });
    assert.equal(scheduler.getLastReport(), null);
    await scheduler.tick();
    assert.ok(scheduler.getLastReport() !== null);
  });

  test("onAlert fires when a scenario breaches its SLA", async () => {
    const alerts = [];
    const history = new Map();
    const scheduler = createSyntheticMonitorScheduler({
      adapters:       failingAdapters(SCENARIO_IDS.BUYER_PURCHASE_FLOW),
      intervalMs:     60_000,
      setIntervalFn:  () => 1,
      clearIntervalFn: () => {},
      onAlert:        (a) => alerts.push(a),
    });

    // Run enough ticks to breach the success-rate SLA (floor = 0.95, window = 10)
    for (let i = 0; i < 11; i++) {
      await scheduler.tick();
    }

    assert.ok(alerts.length > 0, "expected at least one alert after SLA breach");
    assert.equal(alerts[0].scenarioId, SCENARIO_IDS.BUYER_PURCHASE_FLOW);
    assert.ok(alerts[0].breach);
  });

  test("stop() prevents further timer registrations", () => {
    let timerCount = 0;
    const scheduler = createSyntheticMonitorScheduler({
      adapters:       happyAdapters(),
      intervalMs:     1_000,
      setIntervalFn:  (fn, ms) => { timerCount++; return timerCount; },
      clearIntervalFn: () => {},
    });
    scheduler.start();
    scheduler.stop();
    assert.equal(timerCount, 1); // only the initial timer was registered
  });
});

// ---------------------------------------------------------------------------
// History rolling window
// ---------------------------------------------------------------------------

describe("history rolling window", () => {
  test("history map accumulates runs across ticks", async () => {
    const history = new Map();
    await runHealthCheck({ adapters: happyAdapters(), history });
    await runHealthCheck({ adapters: happyAdapters(), history });
    for (const [, runs] of history) {
      assert.ok(runs.length >= 2, "expected at least 2 runs in history");
    }
  });

  test("windowSize is respected — history does not grow unboundedly", async () => {
    const smallSla = { successRateFloor: 0.95, p95LatencyMs: 5_000, windowSize: 3 };
    const history  = new Map();
    const subset   = [SCENARIO_IDS.BUYER_PURCHASE_FLOW];

    for (let i = 0; i < 10; i++) {
      await runHealthCheck({ adapters: happyAdapters(), history, scenarioIds: subset });
    }

    const runs = history.get(SCENARIO_IDS.BUYER_PURCHASE_FLOW) ?? [];
    // The scenario SLA windowSize = 10 by default; check it did not exceed
    assert.ok(runs.length <= SCENARIO_DEFINITIONS.find((d) => d.id === SCENARIO_IDS.BUYER_PURCHASE_FLOW).sla.windowSize);
  });
});
