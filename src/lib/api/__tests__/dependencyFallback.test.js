import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  CIRCUIT_STATE,
  CircuitOpenError,
  buildOutageResponse,
  callWithFallback,
  createCircuitBreaker,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_RECOVERY_WINDOW_MS,
} from "../dependencyFallback.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function succeed() {
  return Promise.resolve("ok");
}

function fail(msg = "dependency error") {
  return Promise.reject(new Error(msg));
}

async function openCircuit(circuit, threshold = DEFAULT_FAILURE_THRESHOLD) {
  for (let i = 0; i < threshold; i++) {
    try { await circuit.execute(fail); } catch { /* expected */ }
  }
}

// ---------------------------------------------------------------------------
// createCircuitBreaker — basic state machine
// ---------------------------------------------------------------------------

describe("createCircuitBreaker", () => {
  it("starts in CLOSED state", () => {
    const cb = createCircuitBreaker({ name: "test" });
    expect(cb.state).toBe(CIRCUIT_STATE.CLOSED);
  });

  it("throws when name is omitted", () => {
    expect(() => createCircuitBreaker()).toThrow(TypeError);
  });

  it("passes calls through while closed", async () => {
    const cb = createCircuitBreaker({ name: "test" });
    const result = await cb.execute(succeed);
    expect(result).toBe("ok");
  });

  it("opens after consecutive failures reach the threshold", async () => {
    const cb = createCircuitBreaker({ name: "test", failureThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      try { await cb.execute(fail); } catch { /* expected */ }
    }
    expect(cb.state).toBe(CIRCUIT_STATE.OPEN);
  });

  it("throws CircuitOpenError when open", async () => {
    const cb = createCircuitBreaker({ name: "test", failureThreshold: 1 });
    try { await cb.execute(fail); } catch { /* expected */ }
    await expect(cb.execute(succeed)).rejects.toThrow(CircuitOpenError);
  });

  it("resets failure count on success", async () => {
    const cb = createCircuitBreaker({ name: "test", failureThreshold: 3 });
    try { await cb.execute(fail); } catch { /* expected */ }
    await cb.execute(succeed);
    expect(cb.consecutiveFailures).toBe(0);
    expect(cb.state).toBe(CIRCUIT_STATE.CLOSED);
  });

  it("fires onStateChange callback on each transition", async () => {
    const changes = [];
    const cb = createCircuitBreaker({
      name: "test",
      failureThreshold: 2,
      onStateChange: (evt) => changes.push(evt),
    });
    try { await cb.execute(fail); } catch { /* expected */ }
    try { await cb.execute(fail); } catch { /* expected */ }
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: CIRCUIT_STATE.CLOSED, to: CIRCUIT_STATE.OPEN });
  });

  it("moves to HALF_OPEN after the recovery window", async () => {
    const cb = createCircuitBreaker({
      name: "test",
      failureThreshold: 1,
      recoveryWindowMs: 0,
    });
    try { await cb.execute(fail); } catch { /* expected */ }
    expect(cb.state).toBe(CIRCUIT_STATE.OPEN);

    // After 0ms window the next execute should probe (half-open)
    await new Promise((r) => setTimeout(r, 5));
    // Execute a successful probe
    await cb.execute(succeed);
    expect(cb.state).toBe(CIRCUIT_STATE.CLOSED);
  });

  it("re-opens on a failed probe in HALF_OPEN state", async () => {
    const cb = createCircuitBreaker({
      name: "test",
      failureThreshold: 1,
      recoveryWindowMs: 0,
    });
    try { await cb.execute(fail); } catch { /* expected */ }
    await new Promise((r) => setTimeout(r, 5));
    try { await cb.execute(fail); } catch { /* expected */ }
    expect(cb.state).toBe(CIRCUIT_STATE.OPEN);
  });

  it("reset() closes the circuit", async () => {
    const cb = createCircuitBreaker({ name: "test", failureThreshold: 1 });
    try { await cb.execute(fail); } catch { /* expected */ }
    cb.reset();
    expect(cb.state).toBe(CIRCUIT_STATE.CLOSED);
    const result = await cb.execute(succeed);
    expect(result).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// callWithFallback
// ---------------------------------------------------------------------------

describe("callWithFallback", () => {
  it("returns the dependency result with fromFallback:false on success", async () => {
    const cb = createCircuitBreaker({ name: "test" });
    const { result, fromFallback } = await callWithFallback({
      circuit: cb,
      call: () => Promise.resolve("data"),
    });
    expect(result).toBe("data");
    expect(fromFallback).toBe(false);
  });

  it("calls fallback when circuit is open", async () => {
    const cb = createCircuitBreaker({ name: "test", failureThreshold: 1 });
    try { await cb.execute(fail); } catch { /* expected */ }

    const { result, fromFallback } = await callWithFallback({
      circuit: cb,
      call: succeed,
      fallback: () => "cached-data",
    });
    expect(result).toBe("cached-data");
    expect(fromFallback).toBe(true);
  });

  it("re-throws CircuitOpenError when no fallback is provided", async () => {
    const cb = createCircuitBreaker({ name: "test", failureThreshold: 1 });
    try { await cb.execute(fail); } catch { /* expected */ }
    await expect(callWithFallback({ circuit: cb, call: succeed })).rejects.toThrow(CircuitOpenError);
  });

  it("re-throws non-circuit errors from the call", async () => {
    const cb = createCircuitBreaker({ name: "test", failureThreshold: 10 });
    await expect(
      callWithFallback({
        circuit: cb,
        call: () => Promise.reject(new Error("actual error")),
        fallback: () => "fallback",
      })
    ).rejects.toThrow("actual error");
  });

  it("throws when circuit argument is missing", async () => {
    await expect(
      callWithFallback({ call: succeed })
    ).rejects.toThrow(TypeError);
  });

  it("throws when call argument is missing", async () => {
    const cb = createCircuitBreaker({ name: "test" });
    await expect(callWithFallback({ circuit: cb })).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// buildOutageResponse
// ---------------------------------------------------------------------------

describe("buildOutageResponse", () => {
  it("includes dependency name and status", () => {
    const body = buildOutageResponse("ipfs");
    expect(body.status).toBe("degraded");
    expect(body.dependency).toBe("ipfs");
    expect(body.message).toContain("ipfs");
    expect(body.timestamp).toBeTruthy();
  });

  it("includes hint when provided", () => {
    const body = buildOutageResponse("stellar-rpc", "Retry in 30s");
    expect(body.hint).toBe("Retry in 30s");
  });

  it("omits hint field when not provided", () => {
    const body = buildOutageResponse("stellar-rpc");
    expect(body.hint).toBeUndefined();
  });
});
