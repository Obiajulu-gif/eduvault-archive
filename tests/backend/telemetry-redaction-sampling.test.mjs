/**
 * High-cardinality telemetry redaction and sampling — Issue #1086
 *
 * Normal path: identifiers in telemetry metadata are pseudonymized before any
 * sink; trace-coherent sampling keeps or drops whole traces. Failure paths:
 * hostile correlation ids, invalid overrides, audit outage, override limits.
 * Retry: the same trace gets the same decision; pseudonymization and override
 * application are idempotent. Authorization: overrides need
 * `telemetry:sampling:override`. Rollback: TELEMETRY_PSEUDONYMIZE=off.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  MAX_SAMPLING_OVERRIDE_TTL_MS,
  REDACTED,
  TelemetryOverrideError,
  applyTelemetrySamplingOverride,
  flushTelemetrySummaries,
  getTelemetryGuardStats,
  listTelemetrySamplingOverrides,
  normalizeCorrelationId,
  recordMetric,
  resetTelemetryGuard,
  resetTelemetrySink,
  revokeTelemetrySamplingOverride,
  setTelemetrySink,
  withTelemetry,
  withTelemetryRoute,
} from "../../src/lib/monitoring/telemetry.js";
import { createTelemetryGuard, traceSamplePosition } from "../../src/lib/monitoring/telemetryGuard.js";
import { isPseudonym, protectLogFields, pseudonymize, resetLogHashKey } from "../../src/lib/monitoring/logSafety.js";

const WALLET = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const admin = { id: "ops-1", role: "admin" };
const noAudit = async () => {};

let records;
let clock;
beforeEach(() => {
  process.env.LOG_HASH_SECRET = "test-log-hash-secret-0123456789abcdef";
  resetLogHashKey();
  records = [];
  clock = 1_000_000;
  setTelemetrySink((record) => records.push(record));
  resetTelemetryGuard({ now: () => clock });
});
afterEach(() => {
  resetTelemetrySink();
  resetTelemetryGuard();
  delete process.env.TELEMETRY_PSEUDONYMIZE;
  delete process.env.TELEMETRY_TRACE_SAMPLE_RATE;
});

/** Ids whose trace position falls below / above a rate, found deterministically. */
function traceIds(predicate, count) {
  const ids = [];
  for (let i = 0; ids.length < count && i < 10_000; i += 1) {
    if (predicate(traceSamplePosition(`trace-${i}`))) ids.push(`trace-${i}`);
  }
  return ids;
}

describe("identifier redaction before every sink", () => {
  test("wallets, user ids, emails and IPs in metadata reach custom sinks only as pseudonyms", async () => {
    await withTelemetry("purchase.complete", "buyer", async () => "ok", {
      metadata: { walletAddress: WALLET, userId: "user-42", clientIp: "203.0.113.9", materialId: "mat-1", note: `paid by ${WALLET}` },
    });
    const { metadata } = records[0];
    assert.equal(metadata.walletAddress, pseudonymize(WALLET));
    assert.match(metadata.walletAddress, /^stellar#[0-9a-f]{16}$/);
    assert.equal(metadata.userId, pseudonymize("user-42"));
    assert.match(metadata.clientIp, /^ip#/);
    assert.equal(metadata.materialId, "mat-1", "internal resource ids stay readable");
    assert.ok(!JSON.stringify(records).includes(WALLET));
  });

  test("identifiers inside error messages are masked and secrets stay redacted", async () => {
    await assert.rejects(
      withTelemetry("payout.release", "worker", async () => {
        throw new Error(`payout to ${WALLET} for alice@example.com failed with token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl`);
      })
    );
    const { error } = records[0];
    assert.ok(error.message.includes(pseudonymize(WALLET)));
    assert.ok(!error.message.includes("alice@example.com"));
    assert.ok(error.message.includes(REDACTED));
  });

  test("pseudonymization is idempotent, so telemetry and plain logs agree", () => {
    const once = pseudonymize(WALLET);
    assert.equal(pseudonymize(once), once);
    assert.equal(isPseudonym(once), true);
    // The pino hook re-protects a telemetry line: the pseudonym must survive unchanged.
    assert.equal(protectLogFields({ walletAddress: once }).walletAddress, once);
  });

  test("high-cardinality metadata never becomes a label", () => {
    recordMetric("conversion.purchase", { buyerAddress: WALLET });
    assert.equal(records[0].metric, "conversion.purchase");
    assert.match(records[0].metadata.buyerAddress, /^stellar#/);
  });

  test("TELEMETRY_PSEUDONYMIZE=off is the rollback switch; secret redaction still applies", () => {
    process.env.TELEMETRY_PSEUDONYMIZE = "off";
    recordMetric("conversion.purchase", { walletAddress: WALLET, apiKey: "sk_live_123" });
    assert.equal(records[0].metadata.walletAddress, WALLET);
    assert.equal(records[0].metadata.apiKey, REDACTED);
  });
});

describe("correlation id hardening", () => {
  test("plain tokens and W3C traceparent values are accepted", () => {
    assert.equal(normalizeCorrelationId("req-123_abc.def:9"), "req-123_abc.def:9");
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    assert.equal(normalizeCorrelationId(` ${traceparent} `), traceparent);
  });

  test("identifier-bearing, oversized, or control-character values are replaced", async () => {
    for (const hostile of [WALLET, "user@example.com", "203.0.113.9", "a".repeat(129), "line\nbreak", "id with spaces", ""]) {
      assert.equal(normalizeCorrelationId(hostile), undefined, hostile);
    }
    const route = withTelemetryRoute("catalog.search", "user", async () => new Response("ok"));
    await route(new Request("http://x/api", { headers: { "x-correlation-id": WALLET } }));
    assert.notEqual(records[0].correlationId, WALLET);
    assert.match(records[0].correlationId, /^[0-9a-f-]{36}$/);
  });
});

describe("trace-coherent sampling", () => {
  test("default rate 1 keeps current behaviour", () => {
    for (let i = 0; i < 20; i += 1) recordMetric("catalog.view", {}, { correlationId: `trace-${i}` });
    assert.equal(records.length, 20);
    assert.equal(getTelemetryGuardStats().traceSampledOut, 0);
  });

  test("a trace is kept or dropped as a whole, identically on retries and across instances", () => {
    const [kept] = traceIds((p) => p < 0.25, 1);
    const [dropped] = traceIds((p) => p >= 0.25, 1);
    const a = createTelemetryGuard({ now: () => clock, config: { traceSampleRate: 0.25 } });
    const b = createTelemetryGuard({ now: () => clock, config: { traceSampleRate: 0.25 } });
    const rec = (correlationId, operation) => ({ operation, actorType: "user", result: "success", correlationId });

    for (const op of ["checkout.quote", "checkout.pay", "checkout.pay"]) {
      assert.equal(a.process(rec(kept, op)).emit, true);
      assert.equal(b.process(rec(kept, op)).emit, true);
      assert.equal(a.process(rec(dropped, op)).emit, false);
      assert.equal(b.process(rec(dropped, op)).emit, false);
    }
  });

  test("failures are never trace-sampled and counts are preserved", () => {
    resetTelemetryGuard({ now: () => clock, config: { traceSampleRate: 0 } });
    for (let i = 0; i < 10; i += 1) recordMetric("catalog.view", {}, { correlationId: `t-${i}` });
    recordMetric("catalog.view", {}, { correlationId: "t-fail", result: "failure" });
    assert.equal(records.length, 1);
    assert.equal(records[0].result, "failure");

    const stats = getTelemetryGuardStats();
    assert.equal(stats.traceSampledOut, 10);
    flushTelemetrySummaries();
    const summary = records.find((r) => r.operation === "telemetry.suppressed_summary");
    assert.equal(summary.value, 10, "kept + suppressed = true volume");
  });

  test("the kept share tracks the configured rate", () => {
    const guard = createTelemetryGuard({ now: () => clock, config: { traceSampleRate: 0.2, success: { burst: 1e6 }, global: { burst: 1e6 } } });
    let kept = 0;
    for (let i = 0; i < 2000; i += 1) {
      if (guard.process({ operation: "catalog.view", actorType: "user", result: "success", correlationId: `c-${i}` }).emit) kept += 1;
    }
    assert.ok(kept > 300 && kept < 500, `kept ${kept}`);
  });

  test("per-operation rates and env configuration are honoured; bad env values fail open", () => {
    const guard = createTelemetryGuard({ now: () => clock, config: { traceSampleRate: 1, operationSampleRates: { "catalog.view": 0 } } });
    assert.equal(guard.process({ operation: "catalog.view", actorType: "user", result: "success", correlationId: "x" }).emit, false);
    assert.equal(guard.process({ operation: "catalog.search", actorType: "user", result: "success", correlationId: "x" }).emit, true);

    process.env.TELEMETRY_TRACE_SAMPLE_RATE = "not-a-number";
    resetTelemetryGuard();
    recordMetric("catalog.view", {}, { correlationId: "x" });
    assert.equal(records.length, 1);
  });
});

describe("sampling overrides", () => {
  const opOverride = (extra = {}) => ({ id: "inc-42", operation: "checkout.quote", rate: 1, ttlMs: 60_000, reason: "INC-42 debugging", ...extra });

  beforeEach(() => {
    resetTelemetryGuard({ now: () => clock, config: { traceSampleRate: 0 } });
  });

  test("an authorized operation override restores full visibility until it expires", async () => {
    const result = await applyTelemetrySamplingOverride({ actor: admin, override: opOverride(), audit: noAudit, now: () => clock });
    assert.equal(result.status, "created");
    recordMetric("checkout.quote", {}, { correlationId: "any" });
    recordMetric("catalog.view", {}, { correlationId: "any" });
    assert.deepEqual(records.map((r) => r.operation), ["checkout.quote"]);

    clock += 60_000;
    recordMetric("checkout.quote", {}, { correlationId: "any" });
    const quotes = records.filter((r) => r.operation === "checkout.quote");
    assert.equal(quotes.length, 1, "expired override no longer applies");
    // The dropped record is still counted (summary flushed after the clock advanced).
    assert.ok(records.some((r) => r.operation === "telemetry.suppressed_summary" && r.metadata.operation === "checkout.quote"));
    assert.deepEqual(listTelemetrySamplingOverrides(), []);
  });

  test("a trace override keeps one request's records", async () => {
    await applyTelemetrySamplingOverride({
      actor: admin,
      override: { id: "trace-1", correlationId: "req-debug-1", rate: 1, ttlMs: 60_000, reason: "repro" },
      audit: noAudit,
      now: () => clock,
    });
    recordMetric("catalog.view", {}, { correlationId: "req-debug-1" });
    recordMetric("catalog.view", {}, { correlationId: "req-other" });
    assert.deepEqual(records.map((r) => r.correlationId), ["req-debug-1"]);
  });

  test("requires the sampling override permission", async () => {
    for (const actor of [null, { id: "u", role: "creator" }, { id: "svc", role: "service" }, { role: "admin" }]) {
      await assert.rejects(
        () => applyTelemetrySamplingOverride({ actor, override: opOverride(), audit: noAudit }),
        (e) => e instanceof TelemetryOverrideError && e.status === 403
      );
      await assert.rejects(() => revokeTelemetrySamplingOverride({ actor, id: "inc-42", audit: noAudit }), (e) => e.status === 403);
    }
    assert.deepEqual(listTelemetrySamplingOverrides(), []);
  });

  test("rejects anything that is not a bounded sampling change", async () => {
    const bad = [
      opOverride({ disableRedaction: true }),
      opOverride({ rate: 1.5 }),
      opOverride({ ttlMs: MAX_SAMPLING_OVERRIDE_TTL_MS + 1 }),
      opOverride({ ttlMs: 10 }),
      opOverride({ correlationId: "both" }),
      { id: "x", rate: 1, ttlMs: 60_000, reason: "neither target" },
      opOverride({ reason: " " }),
      opOverride({ operation: "550e8400-e29b-41d4-a716-446655440000" }),
      opOverride({ id: "bad id" }),
      { id: "t", correlationId: WALLET, rate: 1, ttlMs: 60_000, reason: "x" },
    ];
    for (const override of bad) {
      await assert.rejects(
        () => applyTelemetrySamplingOverride({ actor: admin, override, audit: noAudit }),
        (e) => e.code === "TELEMETRY_OVERRIDE_INVALID",
        JSON.stringify(override)
      );
    }
    await assert.rejects(
      () => applyTelemetrySamplingOverride({ actor: admin, override: opOverride({ disableRedaction: true }), audit: noAudit }),
      /redaction and label validation cannot be disabled/
    );
  });

  test("retries are idempotent; conflicting reuse of an id is a 409", async () => {
    let audits = 0;
    const audit = async () => {
      audits += 1;
    };
    await applyTelemetrySamplingOverride({ actor: admin, override: opOverride(), audit, now: () => clock });
    const again = await applyTelemetrySamplingOverride({ actor: admin, override: opOverride(), audit, now: () => clock });
    assert.equal(again.status, "unchanged");
    assert.equal(audits, 1);
    await assert.rejects(
      () => applyTelemetrySamplingOverride({ actor: admin, override: opOverride({ rate: 0.5 }), audit }),
      (e) => e.code === "TELEMETRY_OVERRIDE_CONFLICT" && e.status === 409
    );
  });

  test("an audit outage blocks the override (fail closed)", async () => {
    const audit = async () => {
      throw new Error("audit sink down");
    };
    await assert.rejects(() => applyTelemetrySamplingOverride({ actor: admin, override: opOverride(), audit }), /audit sink down/);
    assert.deepEqual(listTelemetrySamplingOverrides(), []);
  });

  test("the number of active overrides is bounded", async () => {
    resetTelemetryGuard({ now: () => clock, config: { traceSampleRate: 0, maxOverrides: 2 } });
    await applyTelemetrySamplingOverride({ actor: admin, override: opOverride({ id: "a" }), audit: noAudit, now: () => clock });
    await applyTelemetrySamplingOverride({ actor: admin, override: opOverride({ id: "b" }), audit: noAudit, now: () => clock });
    await assert.rejects(
      () => applyTelemetrySamplingOverride({ actor: admin, override: opOverride({ id: "c" }), audit: noAudit, now: () => clock }),
      (e) => e.code === "TELEMETRY_OVERRIDE_LIMIT" && e.status === 429
    );
  });

  test("revoking is authorized, audited and idempotent; the default audit emits an unsampled record", async () => {
    await applyTelemetrySamplingOverride({ actor: admin, override: opOverride(), now: () => clock });
    const auditRecord = records.find((r) => r.operation === "telemetry.sampling_override");
    assert.equal(auditRecord.metadata.action, "telemetry.sampling_override.applied");
    assert.equal(auditRecord.metadata.actor, pseudonymize("ops-1"), "the operator is pseudonymized like any person id");

    assert.equal((await revokeTelemetrySamplingOverride({ actor: admin, id: "inc-42", audit: noAudit })).status, "revoked");
    assert.equal((await revokeTelemetrySamplingOverride({ actor: admin, id: "inc-42", audit: noAudit })).status, "absent");
    assert.deepEqual(listTelemetrySamplingOverrides(), []);
  });
});
