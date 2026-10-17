import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  ALLOWED_LABEL_KEYS,
  INVALID_LABEL,
  LABEL_REJECTION_REASONS,
  OVERFLOW_LABEL,
  boundFields,
  createTelemetryGuard,
  validateLabelValue,
  validateLabels,
} from "../telemetryGuard.js";
import {
  ACTOR_TYPES,
  REDACTED,
  flushTelemetrySummaries,
  getTelemetryGuardStats,
  recordMetric,
  resetTelemetryGuard,
  resetTelemetrySink,
  sanitizeLogFields,
  setTelemetrySink,
  withTelemetry,
} from "../telemetry.js";

const STELLAR_ADDRESS = `G${"A".repeat(55)}`;
const STELLAR_SECRET = `S${"B".repeat(55)}`;

function clock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

function record(overrides = {}) {
  return {
    operation: "purchase.complete",
    actorType: "user",
    result: "success",
    latencyMs: 1,
    correlationId: "c",
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  };
}

describe("label validation", () => {
  it("accepts low-cardinality category values", () => {
    for (const value of ["purchase.complete", "user", "success", "ERR_TIMEOUT", "testnet", 404, true]) {
      expect(validateLabelValue(value).ok, String(value)).toBe(true);
    }
  });

  it.each([
    ["550e8400-e29b-41d4-a716-446655440000", LABEL_REJECTION_REASONS.LOOKS_LIKE_IDENTIFIER],
    ["64f1a2b3c4d5e6f708192a3b", LABEL_REJECTION_REASONS.LOOKS_LIKE_IDENTIFIER],
    [STELLAR_ADDRESS, LABEL_REJECTION_REASONS.LOOKS_LIKE_IDENTIFIER],
    ["1760000000000", LABEL_REJECTION_REASONS.LOOKS_LIKE_IDENTIFIER],
    ["learner@example.com", LABEL_REJECTION_REASONS.INVALID_CHARACTERS],
    ["GET /api/users/42?token=x", LABEL_REJECTION_REASONS.INVALID_CHARACTERS],
    ["line\nbreak", LABEL_REJECTION_REASONS.INVALID_CHARACTERS],
    ["x".repeat(65), LABEL_REJECTION_REASONS.TOO_LONG],
    [{ a: 1 }, LABEL_REJECTION_REASONS.UNSUPPORTED_TYPE],
    [Number.NaN, LABEL_REJECTION_REASONS.UNSUPPORTED_TYPE],
  ])("rejects unsafe label value %#", (value, reason) => {
    expect(validateLabelValue(value)).toEqual({ ok: false, reason });
  });

  it("drops non-allow-listed and per-entity label keys with a reason", () => {
    const { labels, rejected } = validateLabels({
      operation: "purchase.complete",
      result: "success",
      userId: "u-1",
      walletAddress: "x",
      txHash: "y",
      customThing: "z",
      __proto__: "polluted",
      method: "GET",
    });

    expect(labels).toEqual({ operation: "purchase.complete", result: "success", method: "GET" });
    const byKey = Object.fromEntries(rejected.map((entry) => [entry.key, entry.reason]));
    expect(byKey.userId).toBe(LABEL_REJECTION_REASONS.HIGH_CARDINALITY_KEY);
    expect(byKey.walletAddress).toBe(LABEL_REJECTION_REASONS.HIGH_CARDINALITY_KEY);
    expect(byKey.txHash).toBe(LABEL_REJECTION_REASONS.HIGH_CARDINALITY_KEY);
    expect(byKey.customThing).toBe(LABEL_REJECTION_REASONS.KEY_NOT_ALLOWED);
    expect(Object.keys(labels).every((key) => ALLOWED_LABEL_KEYS.includes(key))).toBe(true);
  });
});

describe("guard dimension handling", () => {
  it("replaces unsafe dimension values and counts the rejection", () => {
    const guard = createTelemetryGuard({ now: clock() });
    const { emit, record: out } = guard.process(
      record({ operation: "GET /materials/64f1a2b3c4d5e6f708192a3b", errorCode: "boom happened for bob@x.io" })
    );

    expect(emit).toBe(true);
    expect(out.operation).toBe(INVALID_LABEL);
    expect(out.errorCode).toBe(INVALID_LABEL);
    expect(guard.getStats().labelRejections[LABEL_REJECTION_REASONS.INVALID_CHARACTERS]).toBe(2);
  });

  it("caps distinct series and folds the excess into one overflow series", () => {
    const guard = createTelemetryGuard({ now: clock(), config: { maxSeries: 5 } });
    const outputs = [];
    for (let i = 0; i < 50; i += 1) {
      outputs.push(guard.process(record({ operation: `op.n${i}` })).record.operation);
    }

    const stats = guard.getStats();
    expect(stats.seriesCount).toBe(6); // 5 admitted + 1 fixed overflow series
    expect(stats.series[`${OVERFLOW_LABEL}|${OVERFLOW_LABEL}|success|`].total).toBe(45);
    expect(outputs.filter((op) => op === OVERFLOW_LABEL).length).toBeGreaterThan(0);
    expect(stats.overflowed).toBeGreaterThan(0);
  });

  it("caps distinct error codes", () => {
    const guard = createTelemetryGuard({ now: clock(), config: { maxErrorCodes: 3 } });
    const codes = [];
    for (let i = 0; i < 10; i += 1) {
      codes.push(guard.process(record({ result: "failure", errorCode: `E_${i}` })).record.errorCode);
    }
    expect(new Set(codes.filter((code) => code !== OVERFLOW_LABEL)).size).toBe(3);
    expect(codes.slice(3).every((code) => code === OVERFLOW_LABEL)).toBe(true);
  });

  it("frees series slots after they go idle", () => {
    const now = clock();
    const guard = createTelemetryGuard({ now, config: { maxSeries: 2, idleMs: 1000 } });
    guard.process(record({ operation: "op.a" }));
    guard.process(record({ operation: "op.b" }));
    expect(guard.process(record({ operation: "op.c" })).record.operation).toBe(OVERFLOW_LABEL);

    now.advance(2000);
    expect(guard.process(record({ operation: "op.c" })).record.operation).toBe("op.c");
  });
});

describe("deterministic sampling under abusive volume", () => {
  const tight = {
    success: { burst: 5, refillPerSec: 1 },
    failure: { burst: 20, refillPerSec: 10 },
    global: { burst: 100, refillPerSec: 100, failureReserveRatio: 0.2 },
  };

  it("keeps the burst budget, then samples out, with the same result on every run", () => {
    const run = () => {
      const guard = createTelemetryGuard({ now: clock(), config: tight });
      return Array.from({ length: 50 }, () => guard.process(record()).emit);
    };
    const first = run();
    expect(first.filter(Boolean)).toHaveLength(5);
    expect(run()).toEqual(first);
  });

  it("never loses counts: kept + suppressed equals true volume", () => {
    const guard = createTelemetryGuard({ now: clock(), config: tight });
    let kept = 0;
    for (let i = 0; i < 1000; i += 1) {
      if (guard.process(record({ value: 1 })).emit) kept += 1;
    }
    const pending = guard.drainSummaries();
    const suppressed = pending.reduce((sum, entry) => sum + entry.suppressedCount, 0);
    const suppressedValue = pending.reduce((sum, entry) => sum + entry.suppressedValue, 0);

    expect(kept).toBe(5);
    expect(kept + suppressed).toBe(1000);
    expect(suppressedValue).toBe(995);
    expect(guard.getStats().series["purchase.complete|user|success|"].total).toBe(1000);
  });

  it("carries the suppressed tally on the next kept record", () => {
    const now = clock();
    const guard = createTelemetryGuard({ now, config: tight });
    for (let i = 0; i < 25; i += 1) guard.process(record());

    now.advance(10_000); // refill
    const next = guard.process(record());
    expect(next.emit).toBe(true);
    expect(next.record.suppressed).toEqual({ count: 20, value: 0 });
  });

  it("keeps failures visible while a success flood is sampled", () => {
    const guard = createTelemetryGuard({ now: clock(), config: tight });
    for (let i = 0; i < 500; i += 1) guard.process(record());

    const failures = Array.from({ length: 10 }, () => guard.process(record({ result: "failure" })).emit);
    expect(failures.every(Boolean)).toBe(true);
  });

  it("reserves global budget for failures when many series flood at once", () => {
    const guard = createTelemetryGuard({
      now: clock(),
      config: { ...tight, success: { burst: 1000, refillPerSec: 1000 } },
    });
    let keptSuccess = 0;
    for (let i = 0; i < 300; i += 1) {
      if (guard.process(record({ operation: `flood.s${i % 50}` })).emit) keptSuccess += 1;
    }
    // 100 global burst, 20 reserved for failures.
    expect(keptSuccess).toBe(80);
    expect(guard.process(record({ operation: "real.failure", result: "failure" })).emit).toBe(true);
  });

  it("refills over time so dashboards recover after the abuse stops", () => {
    const now = clock();
    const guard = createTelemetryGuard({ now, config: tight });
    for (let i = 0; i < 100; i += 1) guard.process(record());
    expect(guard.process(record()).emit).toBe(false);

    now.advance(60_000);
    expect(guard.process(record()).emit).toBe(true);
  });

  it("reports summaries only when due", () => {
    const now = clock();
    const guard = createTelemetryGuard({ now, config: { ...tight, summaryIntervalMs: 1000 } });
    expect(guard.summaryDue()).toBe(false);
    now.advance(1000);
    expect(guard.summaryDue()).toBe(true);
  });
});

describe("field bounding", () => {
  it("caps keys, array length, and depth, and strips control characters", () => {
    const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
    const { value, dropped } = boundFields({
      ...wide,
      list: Array.from({ length: 500 }, (_, i) => i),
      deep: { a: { b: { c: { d: { e: 1 } } } } },
      line: "ok\n{\"forged\":\"log line\"}\r\u0000",
    });

    expect(Object.keys(value)).toHaveLength(40);
    expect(dropped.keys).toBeGreaterThan(0);
    expect(boundFields({ list: Array.from({ length: 500 }, (_, i) => i) }).value.list).toHaveLength(50);
    expect(JSON.stringify(boundFields({ deep: { a: { b: { c: { d: { e: 1 } } } } } }).value)).toContain(
      "[TRUNCATED]"
    );
    expect(boundFields({ line: "a\nb\r\u0000c" }).value.line).toBe("a b  c");
  });

  it("drops hostile and malformed keys", () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":1,"bad key!":2,"ok":3}');
    const { value, dropped } = boundFields(hostile);
    expect(value).toEqual({ ok: 3 });
    expect({}.polluted).toBeUndefined();
    expect(dropped.keys).toBe(3);
  });
});

describe("telemetry integration", () => {
  let records;

  beforeEach(() => {
    records = [];
    setTelemetrySink((entry) => records.push(entry));
    resetTelemetryGuard({
      now: clock(),
      config: { success: { burst: 5, refillPerSec: 1 }, failure: { burst: 20, refillPerSec: 10 } },
    });
  });

  afterEach(() => {
    resetTelemetrySink();
    resetTelemetryGuard();
    delete process.env.TELEMETRY_GUARD;
  });

  it("bounds an abusive stream of unique operations and ids into a handful of series", async () => {
    for (let i = 0; i < 2000; i += 1) {
      await withTelemetry(`GET /materials/${i}${"0".repeat(10)}`, ACTOR_TYPES.USER, async () => "ok", {
        metadata: { materialId: `m-${i}` },
      });
    }

    const stats = getTelemetryGuardStats();
    expect(stats.seriesCount).toBe(1);
    expect(records.length).toBeLessThanOrEqual(10);
    expect(records.every((entry) => entry.operation === INVALID_LABEL)).toBe(true);
    expect(stats.labelRejections[LABEL_REJECTION_REASONS.INVALID_CHARACTERS]).toBe(2000);
    expect(stats.series[`${INVALID_LABEL}|user|success|`].total).toBe(2000);
  });

  it("flushes suppressed counts as a summary metric", () => {
    for (let i = 0; i < 30; i += 1) recordMetric("conversion.purchase", {}, { value: 2 });
    expect(records).toHaveLength(5);

    flushTelemetrySummaries();
    const summary = records.at(-1);
    expect(summary.metric).toBe("telemetry.suppressed");
    expect(summary.value).toBe(25);
    expect(summary.metadata.suppressedValue).toBe(50);
  });

  it("still redacts secrets in bounded metadata and error messages", async () => {
    await expect(
      withTelemetry("material.upload", ACTOR_TYPES.CREATOR, async () => {
        throw new Error(`failed for ${STELLAR_SECRET}\nforged`);
      }, { metadata: { note: `key ${STELLAR_SECRET}`, password: "p" } })
    ).rejects.toThrow();

    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain(STELLAR_SECRET);
    expect(records[0].metadata.password).toBe(REDACTED);
  });

  it("sanitizeLogFields bounds structure and masks secrets together", () => {
    const out = sanitizeLogFields({ note: `a\n${STELLAR_SECRET}`, "bad key": 1, token: "t" });
    expect(out).toEqual({ note: `a ${REDACTED}`, token: REDACTED });
  });

  it("TELEMETRY_GUARD=off restores unsampled, unvalidated emission (rollback switch)", () => {
    process.env.TELEMETRY_GUARD = "off";
    for (let i = 0; i < 50; i += 1) recordMetric("conversion.purchase");
    expect(records).toHaveLength(50);
  });

  it("does not let a throwing sink break the instrumented operation", async () => {
    setTelemetrySink(() => {
      throw new Error("sink down");
    });
    await expect(withTelemetry("purchase.complete", ACTOR_TYPES.USER, async () => "ok")).resolves.toBe("ok");
  });
});
