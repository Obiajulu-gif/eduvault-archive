/**
 * Tests for deterministic fallback behavior for degraded third-party services — Issue #885
 *
 * Covers healthy, degraded, unavailable, recovery, fallback messaging,
 * critical action blocking, and observability events.
 */

import assert from "node:assert/strict";
import { test, describe, beforeEach } from "node:test";

import {
  SERVICE_STATE,
  FALLBACK_ACTION,
  registerService,
  reportServiceState,
  getServiceState,
  getAllServiceStates,
  resolveFallbackAction,
  isCriticalActionBlocked,
  getCriticalActions,
  getFallbackMessage,
  getObservabilityEvents,
  clearObservabilityEvents,
  getServiceHistory,
  resetFallbackRegistry,
  getRegisteredServices,
  isServiceRegistered,
  assertServiceAvailable,
  withFallback,
} from "../../src/lib/fallback.js";

beforeEach(() => {
  resetFallbackRegistry();
});

describe("Fallback — Service Registration (#885)", () => {
  test("registers a service with default policy", () => {
    registerService("pinata", {
      metadata: { type: "ipfs" },
    });
    assert.equal(isServiceRegistered("pinata"), true);
    assert.ok(getRegisteredServices().includes("pinata"));
  });

  test("rejects invalid service name", () => {
    assert.throws(() => registerService(""), /non-empty string/);
    assert.throws(() => registerService(null), /non-empty string/);
  });

  test("rejects invalid state on report", () => {
    registerService("pinata");
    assert.throws(() => reportServiceState("pinata", "broken"), /Invalid state/);
  });

  test("throws for unknown service on report", () => {
    assert.throws(() => reportServiceState("unknown", SERVICE_STATE.DEGRADED), /Unknown service/);
  });
});

describe("Fallback — Healthy State (#885)", () => {
  test("new service starts healthy", () => {
    registerService("stellar");
    const state = getServiceState("stellar");
    assert.equal(state.state, SERVICE_STATE.HEALTHY);
  });

  test("healthy service allows all operations", () => {
    registerService("pinata");
    const result = resolveFallbackAction("pinata", "upload");
    assert.equal(result.action, FALLBACK_ACTION.ALLOW);
  });

  test("healthy service does not block critical actions", () => {
    registerService("stellar", { criticalActions: ["purchase"] });
    assert.equal(isCriticalActionBlocked("stellar"), false);
  });

  test("healthy service returns normal message", () => {
    registerService("email");
    const msg = getFallbackMessage("email", FALLBACK_ACTION.ALLOW);
    assert.ok(msg.includes("operating normally"));
  });
});

describe("Fallback — Degraded State (#885)", () => {
  test("degraded service returns degrade action by default", () => {
    registerService("pinata");
    reportServiceState("pinata", SERVICE_STATE.DEGRADED, "high-latency");
    const result = resolveFallbackAction("pinata", "upload");
    assert.equal(result.action, FALLBACK_ACTION.DEGRADE);
  });

  test("degraded service does not block critical actions", () => {
    registerService("stellar", { criticalActions: ["purchase"] });
    reportServiceState("stellar", SERVICE_STATE.DEGRADED);
    assert.equal(isCriticalActionBlocked("stellar"), false);
  });

  test("degraded service returns user-safe message", () => {
    registerService("pinata");
    reportServiceState("pinata", SERVICE_STATE.DEGRADED);
    const msg = getFallbackMessage("pinata", FALLBACK_ACTION.DEGRADE);
    assert.ok(msg.includes("reduced functionality"));
  });

  test("operation-level policy overrides service-level policy", () => {
    registerService("pinata", {
      operations: {
        upload: { action: FALLBACK_ACTION.BLOCK, reason: "upload-blocked", reason_detail: "Uploads blocked during degradation" },
      },
    });
    reportServiceState("pinata", SERVICE_STATE.DEGRADED);
    const result = resolveFallbackAction("pinata", "upload");
    assert.equal(result.action, FALLBACK_ACTION.BLOCK);
  });
});

describe("Fallback — Unavailable State (#885)", () => {
  test("unavailable service blocks all operations", () => {
    registerService("stellar");
    reportServiceState("stellar", SERVICE_STATE.UNAVAILABLE, "rpc-down");
    const result = resolveFallbackAction("stellar", "default");
    assert.equal(result.action, FALLBACK_ACTION.BLOCK);
  });

  test("unavailable service blocks critical actions", () => {
    registerService("stellar", { criticalActions: ["purchase", "refund"] });
    reportServiceState("stellar", SERVICE_STATE.UNAVAILABLE);
    assert.equal(isCriticalActionBlocked("stellar"), true);
  });

  test("unavailable service returns block message", () => {
    registerService("pinata");
    reportServiceState("pinata", SERVICE_STATE.UNAVAILABLE);
    const msg = getFallbackMessage("pinata", FALLBACK_ACTION.BLOCK);
    assert.ok(msg.includes("temporarily unavailable"));
  });

  test("assertServiceAvailable throws for unavailable service", () => {
    registerService("stellar");
    reportServiceState("stellar", SERVICE_STATE.UNAVAILABLE);
    assert.throws(
      () => assertServiceAvailable("stellar"),
      (err) => err.code === "SERVICE_UNAVAILABLE"
    );
  });

  test("assertServiceAvailable passes for healthy service", () => {
    registerService("stellar");
    const result = assertServiceAvailable("stellar");
    assert.equal(result.action, FALLBACK_ACTION.ALLOW);
  });
});

describe("Fallback — Recovery (#885)", () => {
  test("service can recover from unavailable to healthy", () => {
    registerService("pinata");
    reportServiceState("pinata", SERVICE_STATE.UNAVAILABLE, "outage");
    reportServiceState("pinata", SERVICE_STATE.HEALTHY, "recovered");
    const state = getServiceState("pinata");
    assert.equal(state.state, SERVICE_STATE.HEALTHY);
  });

  test("recovery re-enables blocked operations", () => {
    registerService("stellar", { criticalActions: ["purchase"] });
    reportServiceState("stellar", SERVICE_STATE.UNAVAILABLE);
    assert.equal(isCriticalActionBlocked("stellar"), true);
    reportServiceState("stellar", SERVICE_STATE.HEALTHY);
    assert.equal(isCriticalActionBlocked("stellar"), false);
  });

  test("state history tracks transitions", () => {
    registerService("pinata");
    reportServiceState("pinata", SERVICE_STATE.DEGRADED, "slow");
    reportServiceState("pinata", SERVICE_STATE.UNAVAILABLE, "down");
    reportServiceState("pinata", SERVICE_STATE.HEALTHY, "recovered");
    const history = getServiceHistory("pinata");
    assert.ok(history.length >= 4);
    assert.equal(history[history.length - 1].state, SERVICE_STATE.HEALTHY);
  });

  test("duplicate state report is a no-op", () => {
    registerService("pinata");
    const result = reportServiceState("pinata", SERVICE_STATE.HEALTHY);
    assert.equal(result.changed, false);
  });
});

describe("Fallback — Observability Events (#885)", () => {
  test("state transitions emit observability events", () => {
    clearObservabilityEvents();
    registerService("pinata");
    reportServiceState("pinata", SERVICE_STATE.DEGRADED, "latency");
    reportServiceState("pinata", SERVICE_STATE.UNAVAILABLE, "timeout");
    const events = getObservabilityEvents();
    assert.ok(events.length >= 2);
    assert.equal(events[0].service, "pinata");
    assert.equal(events[0].from, SERVICE_STATE.HEALTHY);
    assert.equal(events[0].to, SERVICE_STATE.DEGRADED);
  });

  test("events can be filtered by service", () => {
    clearObservabilityEvents();
    registerService("pinata");
    registerService("stellar");
    reportServiceState("pinata", SERVICE_STATE.DEGRADED);
    reportServiceState("stellar", SERVICE_STATE.DEGRADED);
    const pinataEvents = getObservabilityEvents("pinata");
    assert.ok(pinataEvents.every((e) => e.service === "pinata"));
  });

  test("events are capped at MAX_OBSERVABILITY_EVENTS", () => {
    clearObservabilityEvents();
    registerService("pinata");
    for (let i = 0; i < 1100; i++) {
      reportServiceState("pinata", SERVICE_STATE.DEGRADED);
      reportServiceState("pinata", SERVICE_STATE.HEALTHY);
    }
    const events = getObservabilityEvents();
    assert.ok(events.length <= 1000);
  });
});

describe("Fallback — User-Safe Messaging (#885)", () => {
  test("allow message does not leak internal details", () => {
    registerService("pinata");
    const msg = getFallbackMessage("pinata", FALLBACK_ACTION.ALLOW);
    assert.ok(!msg.includes("error"));
    assert.ok(!msg.includes("fail"));
  });

  test("block message is user-friendly", () => {
    registerService("stellar");
    const msg = getFallbackMessage("stellar", FALLBACK_ACTION.BLOCK);
    assert.ok(msg.includes("try again later"));
  });

  test("queue message informs user of pending state", () => {
    registerService("email");
    const msg = getFallbackMessage("email", FALLBACK_ACTION.QUEUE);
    assert.ok(msg.includes("queued"));
  });

  test("unknown service returns safe generic message", () => {
    const result = resolveFallbackAction("nonexistent");
    assert.equal(result.action, FALLBACK_ACTION.BLOCK);
    assert.ok(result.message.length > 0);
  });
});

describe("Fallback — withFallback Wrapper (#885)", () => {
  test("passes through when service is healthy", async () => {
    registerService("pinata");
    const handler = async (x) => x * 2;
    const wrapped = withFallback("pinata", "compute", handler);
    const result = await wrapped(5);
    assert.equal(result.ok, true);
    assert.equal(result.result, 10);
  });

  test("returns error when service is unavailable", async () => {
    registerService("stellar");
    reportServiceState("stellar", SERVICE_STATE.UNAVAILABLE);
    const handler = async () => "should-not-run";
    const wrapped = withFallback("stellar", "purchase", handler);
    const result = await wrapped();
    assert.equal(result.ok, false);
    assert.equal(result.code, "SERVICE_UNAVAILABLE");
  });

  test("returns queued when policy says queue", async () => {
    registerService("email", {
      operations: {
        send: { action: FALLBACK_ACTION.QUEUE },
      },
    });
    reportServiceState("email", SERVICE_STATE.DEGRADED);
    const handler = async () => "sent";
    const wrapped = withFallback("email", "send", handler);
    const result = await wrapped();
    assert.equal(result.ok, true);
    assert.equal(result.queued, true);
  });

  test("catches handler errors and returns safe message", async () => {
    registerService("pinata");
    const handler = async () => { throw new Error("internal-details"); };
    const wrapped = withFallback("pinata", "upload", handler);
    const result = await wrapped();
    assert.equal(result.ok, false);
    assert.equal(result.code, "SERVICE_ERROR");
    assert.ok(!result.error.includes("internal-details"));
  });
});

describe("Fallback — Critical Actions (#885)", () => {
  test("tracks critical actions per service", () => {
    registerService("stellar", { criticalActions: ["purchase", "refund", "payout"] });
    const actions = getCriticalActions("stellar");
    assert.deepEqual(actions.sort(), ["purchase", "payout", "refund"]);
  });

  test("critical actions are not blocked when healthy", () => {
    registerService("stellar", { criticalActions: ["purchase"] });
    assert.equal(isCriticalActionBlocked("stellar"), false);
  });

  test("critical actions are not blocked when degraded", () => {
    registerService("stellar", { criticalActions: ["purchase"] });
    reportServiceState("stellar", SERVICE_STATE.DEGRADED);
    assert.equal(isCriticalActionBlocked("stellar"), false);
  });

  test("critical actions are blocked when unavailable", () => {
    registerService("stellar", { criticalActions: ["purchase"] });
    reportServiceState("stellar", SERVICE_STATE.UNAVAILABLE);
    assert.equal(isCriticalActionBlocked("stellar"), true);
  });

  test("service with no critical actions is never blocked", () => {
    registerService("analytics");
    reportServiceState("analytics", SERVICE_STATE.UNAVAILABLE);
    assert.equal(isCriticalActionBlocked("analytics"), false);
  });
});

describe("Fallback — Multi-Service State (#885)", () => {
  test("tracks multiple services independently", () => {
    registerService("pinata");
    registerService("stellar");
    registerService("email");

    reportServiceState("pinata", SERVICE_STATE.DEGRADED);
    reportServiceState("stellar", SERVICE_STATE.UNAVAILABLE);

    const states = getAllServiceStates();
    assert.equal(states.pinata.state, SERVICE_STATE.DEGRADED);
    assert.equal(states.stellar.state, SERVICE_STATE.UNAVAILABLE);
    assert.equal(states.email.state, SERVICE_STATE.HEALTHY);
  });
});
