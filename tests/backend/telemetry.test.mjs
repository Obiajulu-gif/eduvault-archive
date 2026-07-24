/**
 * Telemetry contract tests for Issue #20 (Observability).
 *
 * Covers: context propagation, redaction, failure-path spans,
 * duplicate/retry attributes, metric cardinality limits, and
 * alert fixture evaluation.
 */

import assert from "node:assert/strict";
import { test, describe, beforeEach } from "node:test";

import {
  runWithContext,
  getContext,
  parseTraceparent,
  buildTraceparent,
  generateTraceId,
  generateSpanId,
  currentCorrelationId,
  currentTraceparent,
} from "../../src/lib/telemetry/context.js";
import { redactFields, isDeniedField } from "../../src/lib/telemetry/redact.js";
import { withSpan, recentSpans, clearRecentSpans, disableOtelForTesting } from "../../src/lib/telemetry/tracing.js";
import {
  incrementCounter,
  recordHistogram,
  setGauge,
  getMetricsSnapshot,
  resetMetrics,
  toPrometheusFormat,
} from "../../src/lib/telemetry/metrics.js";
import { evaluateAlerts, ALERT_RULES } from "../../src/lib/telemetry/alerts.js";
import {
  applyIndexedEvent,
  runIndexerBatch,
} from "../../src/lib/indexer/stellarIndexer.js";
import { COLLECTIONS } from "../../src/lib/backend/schemaContracts.js";
import { createAuditEntry } from "../../src/lib/api/audit.js";

disableOtelForTesting();

beforeEach(() => {
  resetMetrics();
  clearRecentSpans();
});

// ---------------------------------------------------------------------------
// Context propagation
// ---------------------------------------------------------------------------
describe("context propagation", () => {
  test("runWithContext generates a fresh trace when no traceparent is given", async () => {
    await runWithContext({}, async () => {
      const ctx = getContext();
      assert.ok(ctx.traceId, "traceId should be generated");
      assert.ok(ctx.correlationId, "correlationId should be generated");
      assert.equal(ctx.parentSpanId, null);
    });
  });

  test("runWithContext resumes an existing trace from an incoming traceparent", async () => {
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    const traceparent = buildTraceparent(traceId, spanId);

    await runWithContext({ traceparent }, async () => {
      const ctx = getContext();
      assert.equal(ctx.traceId, traceId, "should continue the same traceId");
      assert.equal(ctx.parentSpanId, spanId, "incoming spanId becomes the parent");
    });
  });

  test("malformed traceparent falls back to a new trace instead of throwing", async () => {
    await runWithContext({ traceparent: "garbage-not-a-traceparent" }, async () => {
      const ctx = getContext();
      assert.ok(ctx.traceId);
    });
  });

  test("context crosses an HTTP-request-shaped call into a worker-job-shaped call (simulated boundary)", async () => {
    // Simulate: HTTP request creates context + workflow stamps telemetry.
    let stampedTelemetry;
    await runWithContext({ route: "checkout" }, async () => {
      stampedTelemetry = {
        correlationId: currentCorrelationId(),
        traceparent: currentTraceparent(),
      };
    });

    // Simulate: worker picks up the workflow later, resumes the trace.
    await runWithContext(
      { correlationId: stampedTelemetry.correlationId, traceparent: stampedTelemetry.traceparent, jobType: "purchase" },
      async () => {
        const ctx = getContext();
        assert.equal(ctx.correlationId, stampedTelemetry.correlationId, "correlationId carries across the boundary");
        assert.equal(ctx.jobType, "purchase");
      }
    );
  });

  test("getContext returns null outside of any context", () => {
    assert.equal(getContext(), null);
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------
describe("redaction", () => {
  test("strips known PII fields", () => {
    const safe = redactFields({ email: "a@b.com", password: "hunter2", materialId: "m1" });
    assert.equal(safe.email, "[REDACTED]");
    assert.equal(safe.password, "[REDACTED]");
    assert.equal(safe.materialId, "m1");
  });

  test("is case-insensitive on field names", () => {
    const safe = redactFields({ Email: "a@b.com", PASSWORD: "x" });
    assert.equal(safe.Email, "[REDACTED]");
    assert.equal(safe.PASSWORD, "[REDACTED]");
  });

  test("retains wallet addresses (pseudonymous, not PII)", () => {
    const safe = redactFields({ buyerAddress: "GABC123" });
    assert.equal(safe.buyerAddress, "GABC123");
  });

  test("isDeniedField helper matches redactFields behavior", () => {
    assert.equal(isDeniedField("email"), true);
    assert.equal(isDeniedField("materialId"), false);
  });
});

// ---------------------------------------------------------------------------
// Spans (success + failure paths), redaction inside spans
// ---------------------------------------------------------------------------
describe("tracing spans", () => {
  test("successful span is recorded with ok status and redacted attributes", async () => {
    await runWithContext({}, async () => {
      await withSpan("test.op", { materialId: "m1", email: "leak@example.com" }, async (span) => {
        span.setAttribute("outcome", "success");
      });
    });

    const span = recentSpans.at(-1);
    assert.equal(span.status, "ok");
    assert.equal(span.attributes.materialId, "m1");
    assert.equal(span.attributes.email, "[REDACTED]");
    assert.equal(span.attributes.outcome, "success");
  });

  test("failure-path span records exception and error status, then rethrows", async () => {
    await runWithContext({}, async () => {
      await assert.rejects(
        () =>
          withSpan("test.failing_op", {}, async () => {
            throw new Error("boom");
          }),
        /boom/
      );
    });

    const span = recentSpans.at(-1);
    assert.equal(span.status, "error");
    assert.equal(span.error, "boom");
  });

  test("child spans link to their parent span via context", async () => {
    await runWithContext({}, async () => {
      await withSpan("parent.op", {}, async () => {
        await withSpan("child.op", {}, async () => {});
      });
    });

    const child = recentSpans.find((s) => s.name === "child.op");
    const parent = recentSpans.find((s) => s.name === "parent.op");
    assert.equal(child.traceId, parent.traceId, "same trace");
  });
});

// ---------------------------------------------------------------------------
// Audit record contract
// ---------------------------------------------------------------------------
describe("structured audit records", () => {
  test("audit entries inherit correlation context and only retain allow-listed fields", async () => {
    await runWithContext({ route: "upload" }, async () => {
      const entry = createAuditEntry({ event: "upload_complete", uploadId: "up-1", email: "private@example.com", fileBytes: "secret" });
      assert.equal(entry.event, "upload_complete");
      assert.equal(entry.uploadId, "up-1");
      assert.equal(entry.route, "upload");
      assert.ok(entry.correlationId);
      assert.equal(entry.email, undefined);
      assert.equal(entry.fileBytes, undefined);
    });
  });
});

// ---------------------------------------------------------------------------
// Metrics: cardinality limits
// ---------------------------------------------------------------------------
describe("metric cardinality limits", () => {
  test("counter drops new label combinations past the cardinality cap instead of growing unbounded", () => {
    for (let i = 0; i < 250; i++) {
      incrementCounter("test_counter_cardinality", { uniqueLabel: `value-${i}` });
    }
    const snapshot = getMetricsSnapshot();
    const seriesCount = Object.keys(snapshot.counters.test_counter_cardinality).length;
    assert.ok(seriesCount <= 200, `expected capped series count, got ${seriesCount}`);
  });

  test("existing label combinations keep updating even after the cap is hit", () => {
    incrementCounter("test_counter_existing", { route: "checkout" });
    for (let i = 0; i < 250; i++) {
      incrementCounter("test_counter_existing", { uniqueLabel: `value-${i}` });
    }
    incrementCounter("test_counter_existing", { route: "checkout" });
    const snapshot = getMetricsSnapshot();
    assert.equal(snapshot.counters.test_counter_existing['route="checkout"'], 2);
  });

  test("histogram exposes p50/p95/p99 percentiles", () => {
    for (let i = 1; i <= 100; i++) {
      recordHistogram("test_histogram", { route: "checkout" }, i * 10);
    }
    const snapshot = getMetricsSnapshot();
    const stats = snapshot.histograms.test_histogram['route="checkout"'];
    assert.equal(stats.count, 100);
    assert.ok(stats.p95 >= 900 && stats.p95 <= 1000);
  });

  test("toPrometheusFormat produces valid-looking exposition text", () => {
    incrementCounter("test_prom_counter", { route: "checkout" });
    setGauge("test_prom_gauge", { source: "stellar" }, 42);
    const text = toPrometheusFormat();
    assert.match(text, /# TYPE test_prom_counter counter/);
    assert.match(text, /test_prom_gauge\{source="stellar"\} 42/);
  });
});

// ---------------------------------------------------------------------------
// Duplicate / retry attributes on the indexer (feeds workflow + metrics)
// ---------------------------------------------------------------------------
describe("indexer duplicate/retry attributes", () => {
  function createCollection() {
    const records = new Map();
    return {
      records,
      async findOne(query) {
        if (query._id) return records.get(query._id) || null;
        return null;
      },
      async insertOne(doc) {
        if (records.has(doc._id)) {
          const error = new Error("duplicate");
          error.code = 11000;
          throw error;
        }
        records.set(doc._id, doc);
      },
      async updateOne(query, update, options = {}) {
        const key = query._id || `${query.materialId}:${query.buyerAddress || ""}`;
        const current = records.get(key) || {};
        if (!records.has(key) && !options.upsert) return;
        records.set(key, { ...current, ...(update.$setOnInsert || {}), ...(update.$set || {}) });
      },
      async deleteOne(query) {
        if (query._id) records.delete(query._id);
      },
      find(query) {
        const all = [...records.values()];
        return { [Symbol.asyncIterator]: async function* () { for (const r of all) yield r; } };
      },
    };
  }

  function createDb() {
    const collections = new Map();
    return {
      collection(name) {
        if (!collections.has(name)) collections.set(name, createCollection());
        return collections.get(name);
      },
    };
  }

  test("reprocessing the same event is marked as skipped (duplicate attribute)", async () => {
    const db = createDb();
    const event = { id: "ledger:tx:1", type: "material.registered", materialId: "m1" };

    const first = await applyIndexedEvent(db, event);
    assert.equal(first.skipped, false);

    const second = await applyIndexedEvent(db, event);
    assert.equal(second.skipped, true, "duplicate event should carry skipped=true");
  });

  test("runIndexerBatch increments applied/skipped metrics and sets dead-letter gauge", async () => {
    const db = createDb();
    const event = { id: "ledger:tx:2", type: "material.registered", materialId: "m2" };

    const result = await runIndexerBatch({
      db,
      eventSource: { async getEvents() { return { events: [event], nextCursor: null, lastLedger: 100 }; } },
    });

    assert.equal(result.applied, 1);
    assert.equal(result.skipped, 0);

    const snapshot = getMetricsSnapshot();
    assert.equal(snapshot.counters.indexer_events_applied_total['source="stellar"'], 1);
    assert.ok("indexer_dead_letter_count" in snapshot.gauges);
    assert.equal(snapshot.counters.stellar_sync_batches_total['outcome="success",source="stellar"'], 1);
    assert.ok(recentSpans.some((span) => span.name === "stellar.sync.fetch"));
    assert.ok(recentSpans.some((span) => span.name === "stellar.sync.apply"));
  });
});

// ---------------------------------------------------------------------------
// Alert fixture evaluation
// ---------------------------------------------------------------------------
describe("alert fixture evaluation", () => {
  test("PurchaseLatencyHigh fires when p95 exceeds threshold", () => {
    const fixture = { histograms: { purchase_latency_ms: { "": { p95: 9000, count: 50 } } } };
    const fired = evaluateAlerts(fixture);
    assert.ok(fired.some((a) => a.name === "PurchaseLatencyHigh"));
  });

  test("PurchaseLatencyHigh does not fire below threshold", () => {
    const fixture = { histograms: { purchase_latency_ms: { "": { p95: 2000, count: 50 } } } };
    const fired = evaluateAlerts(fixture);
    assert.ok(!fired.some((a) => a.name === "PurchaseLatencyHigh"));
  });

  test("PurchaseSuccessRateLow fires below 95% success with enough samples", () => {
    const fixture = { counters: { purchase_total: { 'outcome="success"': 80, 'outcome="failed"': 20 } } };
    const fired = evaluateAlerts(fixture);
    assert.ok(fired.some((a) => a.name === "PurchaseSuccessRateLow"));
  });

  test("PurchaseSuccessRateLow does not page on low sample counts", () => {
    const fixture = { counters: { purchase_total: { 'outcome="success"': 1, 'outcome="failed"': 1 } } };
    const fired = evaluateAlerts(fixture);
    assert.ok(!fired.some((a) => a.name === "PurchaseSuccessRateLow"));
  });

  test("IndexerLedgerLagHigh and DeadLetterBacklogGrowing fire from gauge fixtures", () => {
    const fixture = {
      gauges: {
        indexer_ledger_lag: { 'source="stellar"': 120 },
        indexer_dead_letter_count: { 'source="stellar"': 40 },
      },
    };
    const fired = evaluateAlerts(fixture);
    assert.ok(fired.some((a) => a.name === "IndexerLedgerLagHigh"));
    assert.ok(fired.some((a) => a.name === "DeadLetterBacklogGrowing"));
  });

  test("every alert rule has a runbook reference (actionable alerts map to runbooks)", () => {
    for (const rule of ALERT_RULES) {
      assert.match(rule.runbook, /docs\/observability-slos\.md/);
    }
  });

  test("empty snapshot fires no alerts", () => {
    assert.deepEqual(evaluateAlerts({}), []);
  });
});
