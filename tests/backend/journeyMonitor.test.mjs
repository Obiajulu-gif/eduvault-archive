/**
 * Tests for the synthetic journey monitor (#monitor).
 *
 * The monitor exists so the purchase → entitlement → download workflow has a
 * runnable, blamable health check. These tests pin the reporting contract that
 * the CLI and alerting depend on: step order, latency capture, failure
 * classification, and deterministic skip/blame behaviour.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  JOURNEY_DEFINITION,
  JOURNEY_STEP_IDS,
  JOURNEY_STEP_STATUSES,
  classifyJourneyFailure,
  runSyntheticJourney,
  summarizeJourneyReports,
} from "../../src/lib/monitoring/journeyMonitor.js";

function buildHappyHarness(overrides = {}) {
  const steps = {};
  for (const definition of JOURNEY_DEFINITION) {
    steps[definition.id] = async () => ({ step: definition.id });
  }
  return { steps: { ...steps, ...overrides } };
}

describe("journey monitor — happy path", () => {
  test("runs every critical step in order and reports latency", async () => {
    let clock = 1_000;
    const report = await runSyntheticJourney({
      harness: buildHappyHarness(),
      runId: "run-1",
      now: () => {
        clock += 7; // deterministic per-call advance
        return clock;
      },
    });

    assert.equal(report.ok, true);
    assert.equal(report.runId, "run-1");
    assert.deepEqual(
      report.steps.map((step) => step.id),
      JOURNEY_DEFINITION.map((step) => step.id),
    );
    for (const step of report.steps) {
      assert.equal(step.status, JOURNEY_STEP_STATUSES.PASSED);
      assert.ok(step.durationMs >= 0);
      assert.ok(step.dependency);
      assert.equal(step.error, null);
    }
    assert.deepEqual(report.failures, []);
    assert.equal(report.blame.primary, null);
    assert.ok(report.durationMs >= 0);
  });

  test("carries per-step detail forward so later steps can reuse it", async () => {
    const report = await runSyntheticJourney({
      harness: buildHappyHarness({
        [JOURNEY_STEP_IDS.CHECKOUT_QUOTE]: async () => ({ quoteId: "q-7" }),
        [JOURNEY_STEP_IDS.PURCHASE_CONFIRM]: async ({ results }) => {
          assert.equal(results[JOURNEY_STEP_IDS.CHECKOUT_QUOTE].quoteId, "q-7");
          return { purchaseId: "p-7" };
        },
      }),
    });
    assert.equal(report.ok, true);
    assert.deepEqual(report.steps[1].detail, { purchaseId: "p-7" });
  });
});

describe("journey monitor — failure reporting and dependency blame", () => {
  test("stops at the first failure, skips the rest, and blames the right dependency", async () => {
    const report = await runSyntheticJourney({
      harness: buildHappyHarness({
        [JOURNEY_STEP_IDS.CHECKOUT_QUOTE]: async () => {
          throw new Error("Checkout quote expired. Refresh the listing to request a new quote.");
        },
      }),
    });

    assert.equal(report.ok, false);
    assert.equal(report.failures.length, 1);
    assert.deepEqual(report.failures[0], {
      stepId: JOURNEY_STEP_IDS.CHECKOUT_QUOTE,
      dependency: "checkout-quotes",
      code: "unknown_error",
      message: "Checkout quote expired. Refresh the listing to request a new quote.",
    });
    assert.equal(report.blame.primary, "checkout-quotes");
    assert.equal(report.steps[0].status, JOURNEY_STEP_STATUSES.FAILED);
    for (const step of report.steps.slice(1)) {
      assert.equal(step.status, JOURNEY_STEP_STATUSES.SKIPPED);
    }
  });

  test("classifies mongo, capability, and explicit dependencies", () => {
    const mongo = classifyJourneyFailure(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:27017 server selection timed out"), { code: "MongoServerSelectionError" }),
      JOURNEY_DEFINITION[1],
    );
    assert.equal(mongo.dependency, "mongodb");

    const capability = classifyJourneyFailure(new Error("capability signature mismatch"), JOURNEY_DEFINITION[4]);
    assert.equal(capability.dependency, "download-capability");

    const explicit = classifyJourneyFailure(
      Object.assign(new Error("upstream bleh"), { dependency: "stellar-rpc", retryable: true }),
      JOURNEY_DEFINITION[2],
    );
    assert.equal(explicit.dependency, "stellar-rpc");
    assert.equal(explicit.retryable, true);

    const fallback = classifyJourneyFailure(new Error("something new"), JOURNEY_DEFINITION[3]);
    assert.equal(fallback.dependency, "entitlement-policy");
  });

  test("times out a hung step and reports it as a failure", async () => {
    const report = await runSyntheticJourney({
      harness: buildHappyHarness({
        [JOURNEY_STEP_IDS.ENTITLEMENT_AUTHORIZE]: () => new Promise(() => {}),
      }),
      stepTimeoutMs: 20,
    });

    const step = report.steps.find((candidate) => candidate.id === JOURNEY_STEP_IDS.ENTITLEMENT_AUTHORIZE);
    assert.equal(step.status, JOURNEY_STEP_STATUSES.FAILED);
    assert.equal(step.error.code, "journey_step_timeout");
    assert.equal(report.ok, false);
  });

  test("fails loudly when the harness is missing a step", async () => {
    const harness = buildHappyHarness();
    delete harness.steps[JOURNEY_STEP_IDS.DOWNLOAD_CAPABILITY];

    const report = await runSyntheticJourney({ harness });
    const step = report.steps.find((candidate) => candidate.id === JOURNEY_STEP_IDS.DOWNLOAD_CAPABILITY);
    assert.equal(step.status, JOURNEY_STEP_STATUSES.FAILED);
    assert.equal(step.error.code, "harness_step_missing");
  });

  test("rejects a harness with no steps map", async () => {
    await assert.rejects(() => runSyntheticJourney({ harness: {} }), /harness with a steps map/);
  });
});

describe("journey monitor — summary aggregation", () => {
  test("computes success rate, per-step latency percentiles, and blame tally", async () => {
    let clock = 0;
    const bump = (delta) => {
      clock += delta;
      return clock;
    };

    const passing = await runSyntheticJourney({
      harness: buildHappyHarness(),
      now: () => bump(10),
    });
    const failing = await runSyntheticJourney({
      harness: buildHappyHarness({
        [JOURNEY_STEP_IDS.PURCHASE_CONFIRM]: async () => {
          throw new Error("purchases lookup failed: server selection timed out");
        },
      }),
      now: () => bump(5),
    });

    const summary = summarizeJourneyReports([passing, failing]);
    assert.equal(summary.runs, 2);
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.successRate, 0.5);
    assert.ok(summary.latency.overall.avg >= 0);
    assert.equal(summary.latency.steps[JOURNEY_STEP_IDS.PURCHASE_CONFIRM].statuses.failed, 1);
    assert.equal(summary.latency.steps[JOURNEY_STEP_IDS.CHECKOUT_QUOTE].statuses.passed, 2);
    assert.deepEqual(summary.blame, [{ dependency: "mongodb", failures: 1 }]);
  });

  test("handles an empty report list without throwing", () => {
    const summary = summarizeJourneyReports([]);
    assert.equal(summary.runs, 0);
    assert.equal(summary.successRate, null);
    assert.equal(summary.latency.overall, null);
    assert.deepEqual(summary.blame, []);
  });
});
