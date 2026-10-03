import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  ACTOR_TYPES,
  CORE_OPERATIONS,
  REDACTED,
  REQUIRED_TELEMETRY_FIELDS,
  TELEMETRY_RESULT,
  recordMetric,
  redactSensitive,
  resetTelemetrySink,
  setTelemetrySink,
  validateTelemetryRecord,
  withTelemetry,
  withTelemetryRoute,
} from "../telemetry.js";

const STELLAR_SECRET = `S${"A".repeat(55)}`;
const JWT = [
  Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
  Buffer.from('{"sub":"1234567890"}').toString("base64url"),
  "A".repeat(43),
].join(".");
const EMAIL = "learner@example.com";

let records;

beforeEach(() => {
  records = [];
  setTelemetrySink((record) => records.push(record));
});

afterEach(() => {
  resetTelemetrySink();
});

describe("telemetry core operation coverage (#788)", () => {
  it("declares at least five distinct core operations", () => {
    expect(CORE_OPERATIONS.length).toBeGreaterThanOrEqual(5);
    const names = new Set(CORE_OPERATIONS.map((entry) => entry.operation));
    expect(names.size).toBeGreaterThanOrEqual(5);
  });

  it("emits the full fixed field set for every core operation", async () => {
    for (const entry of CORE_OPERATIONS) {
      await withTelemetry(entry.operation, entry.actorType, async () => "ok");
    }

    expect(records).toHaveLength(CORE_OPERATIONS.length);
    expect(CORE_OPERATIONS.length).toBeGreaterThanOrEqual(5);

    for (const record of records) {
      const { valid, missing } = validateTelemetryRecord(record);
      expect(missing, `missing for ${record.operation}: ${missing.join(",")}`).toEqual([]);
      expect(valid).toBe(true);
      for (const field of REQUIRED_TELEMETRY_FIELDS) {
        expect(record[field], `${record.operation}.${field}`).toBeDefined();
      }
      expect(record.result).toBe(TELEMETRY_RESULT.SUCCESS);
    }

    const operations = records.map((record) => record.operation);
    expect(new Set(operations).size).toBeGreaterThanOrEqual(5);
  });
});

describe("success and failure emission", () => {
  it("emits success telemetry and returns the wrapped value", async () => {
    const result = await withTelemetry("purchase.complete", ACTOR_TYPES.USER, async () => ({ id: 1 }));

    expect(result).toEqual({ id: 1 });
    expect(records).toHaveLength(1);
    expect(records[0].result).toBe(TELEMETRY_RESULT.SUCCESS);
    expect(records[0].operation).toBe("purchase.complete");
    expect(records[0].actorType).toBe(ACTOR_TYPES.USER);
  });

  it("emits failure telemetry and rethrows thrown errors", async () => {
    await expect(
      withTelemetry("material.upload", ACTOR_TYPES.CREATOR, async () => {
        throw new Error("pin failed");
      })
    ).rejects.toThrow("pin failed");

    expect(records).toHaveLength(1);
    expect(records[0].result).toBe(TELEMETRY_RESULT.FAILURE);
    expect(records[0].operation).toBe("material.upload");
    expect(records[0].error.message).toBe("pin failed");
  });

  it("classifies non-throwing results as failures via isFailure", async () => {
    await withTelemetry("material.download", ACTOR_TYPES.USER, async () => ({ status: 403 }), {
      isFailure: (response) => response.status >= 400,
      failureCode: "access_denied",
    });

    expect(records[0].result).toBe(TELEMETRY_RESULT.FAILURE);
    expect(records[0].errorCode).toBe("access_denied");
  });

  it("infers failure from a route response with status >= 400", async () => {
    const handler = withTelemetryRoute("indexer.ingest", ACTOR_TYPES.SYSTEM, async () => ({
      status: 500,
      body: {},
    }));

    await handler({ headers: { get: () => null } });

    expect(records).toHaveLength(1);
    expect(records[0].result).toBe(TELEMETRY_RESULT.FAILURE);
    expect(records[0].operation).toBe("indexer.ingest");
  });
});

describe("latency measurement", () => {
  it("records a measured, non-negative latency", async () => {
    await withTelemetry("wallet.fetch_balances", ACTOR_TYPES.USER, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: "loaded" };
    });

    expect(typeof records[0].latencyMs).toBe("number");
    expect(records[0].latencyMs).toBeGreaterThanOrEqual(10);
  });
});

describe("redaction of sensitive values", () => {
  it("never emits wallet secrets, JWTs, emails, credentials, or cookies", async () => {
    await withTelemetry("purchase.complete", ACTOR_TYPES.USER, async () => "ok", {
      metadata: {
        orderId: "order-42",
        materialId: "material-7",
        password: "hunter2",
        authorization: `Bearer ${JWT}`,
        cookie: "session=super-secret",
        email: EMAIL,
        jwt: JWT,
        walletPrivateKey: STELLAR_SECRET,
        nested: { token: "tok_live_123", contact: `reach ${EMAIL}` },
        tags: ["safe", STELLAR_SECRET],
      },
    });

    const serialized = JSON.stringify(records[0]);

    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain(JWT);
    expect(serialized).not.toContain(EMAIL);
    expect(serialized).not.toContain(STELLAR_SECRET);
    expect(serialized).not.toContain("tok_live_123");
    expect(serialized).not.toContain("super-secret");

    // Allow-listed, non-sensitive metadata survives.
    expect(records[0].metadata.orderId).toBe("order-42");
    expect(records[0].metadata.materialId).toBe("material-7");
    expect(records[0].metadata.tags[0]).toBe("safe");

    // Sensitive keys are explicitly masked rather than dropped silently.
    expect(records[0].metadata.password).toBe(REDACTED);
    expect(records[0].metadata.email).toBe(REDACTED);
  });

  it("masks sensitive shapes anywhere inside a string", () => {
    const masked = redactSensitive(`key=${STELLAR_SECRET} mail=${EMAIL} jwt=${JWT}`);
    expect(masked).not.toContain(STELLAR_SECRET);
    expect(masked).not.toContain(EMAIL);
    expect(masked).not.toContain(JWT);
    expect(masked).toContain(REDACTED);
  });
});

describe("recordMetric", () => {
  it("emits a metric with the fixed field set", () => {
    recordMetric(
      "conversion.purchase",
      { materialId: "material-7" },
      { operation: "purchase.complete", actorType: ACTOR_TYPES.USER, result: TELEMETRY_RESULT.SUCCESS }
    );

    expect(records).toHaveLength(1);
    expect(records[0].metric).toBe("conversion.purchase");
    expect(records[0].value).toBe(1);
    expect(validateTelemetryRecord(records[0]).valid).toBe(true);
  });
});

describe("validateTelemetryRecord", () => {
  it("reports missing fields for incomplete records", () => {
    const { valid, missing } = validateTelemetryRecord({ operation: "x" });
    expect(valid).toBe(false);
    expect(missing).toEqual(
      expect.arrayContaining(["actorType", "result", "latencyMs", "correlationId", "timestamp", "schemaVersion"])
    );
  });
});
