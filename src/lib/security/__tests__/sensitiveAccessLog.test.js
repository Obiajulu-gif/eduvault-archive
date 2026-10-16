import { describe, expect, it, vi } from "vitest";
import {
  SensitiveAccessDeniedError,
  buildSensitiveAccessEvent,
  createAuditLedgerSink,
  createSensitiveAccessLogger,
  detectAccessAnomalies,
  redactSensitivePayload,
  sanitizeFieldNames,
} from "../sensitiveAccessLog.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const SECRETS = ["learner@example.com", "sup3r-secret", "tok_live_123", "4111-1111-1111-1111"];

function makeHarness(overrides = {}) {
  const events = [];
  const anomalies = [];
  const logger = createSensitiveAccessLogger({
    sink: async (event) => events.push(event),
    onAnomaly: (signal, event) => anomalies.push({ signal, event }),
    now: () => NOW,
    ...overrides,
  });
  return { logger, events, anomalies };
}

describe("sensitive field access logging", () => {
  it("logs authorized access with field names only, never values", async () => {
    const { logger, events } = makeHarness();

    const { event } = await logger.record({
      actorId: "actor-1",
      actorType: "creator",
      purpose: "payout-review",
      resourceType: "creator_profile",
      resourceId: "cp-1",
      fields: ["email", "fullName"],
      decision: "allowed",
      correlationId: "corr-1",
      metadata: { email: SECRETS[0], fullName: "Ada Learner", note: "reviewed" },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toBe(event);
    expect(event).toMatchObject({
      actorId: "actor-1",
      actorType: "creator",
      purpose: "payout-review",
      resourceType: "creator_profile",
      resourceId: "cp-1",
      decision: "allowed",
      correlationId: "corr-1",
      at: NOW.toISOString(),
    });
    expect(event.fields).toEqual(["email", "fullName"]);

    const serialized = JSON.stringify(event);
    for (const secret of SECRETS) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("Ada Learner");
    // The sensitive metadata keys are present but redacted.
    expect(event.metadata).toEqual({ email: "[redacted]", fullName: "[redacted]", note: "reviewed" });
  });

  it("captures denied attempts and fails closed after logging them", async () => {
    const { logger, events } = makeHarness();

    await expect(
      logger.record({
        actorId: "actor-2",
        actorType: "user",
        purpose: "self-service",
        resourceType: "user",
        resourceId: "u-2",
        fields: ["passwordHash"],
        decision: "denied",
        correlationId: "corr-denied",
      }),
    ).rejects.toBeInstanceOf(SensitiveAccessDeniedError);

    // The denied attempt still reached the sink and the in-memory history.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: "denied", resourceId: "u-2" });
    expect(logger.getHistory()).toHaveLength(1);

    let error;
    try {
      await logger.record({
        actorId: "actor-2",
        purpose: "self-service",
        resourceType: "user",
        resourceId: "u-2",
        fields: ["passwordHash"],
        decision: "denied",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SensitiveAccessDeniedError);
    expect(error.code).toBe("SENSITIVE_ACCESS_DENIED");
    expect(error.event).toMatchObject({ decision: "denied" });
    expect(JSON.stringify(error.event)).not.toContain("[object");
  });

  it("emits a bounded bulk-access anomaly signal above the threshold", async () => {
    const { logger, events, anomalies } = makeHarness({
      thresholds: { bulkFieldCount: 3, bulkResourceCount: 5, denialCount: 5 },
    });

    await logger.record({
      actorId: "actor-3",
      actorType: "admin",
      purpose: "export",
      resourceType: "user",
      resourceId: "u-3",
      fields: ["email", "phone", "ssn", "dob"],
      decision: "allowed",
      correlationId: "corr-bulk",
    });

    expect(events).toHaveLength(1);
    expect(anomalies).toHaveLength(1);
    const [{ signal }] = anomalies;
    expect(signal).toMatchObject({
      type: "bulk_access",
      actorId: "actor-3",
      fieldCount: 4,
      resourceCount: 1,
      threshold: { fields: 3, resources: 5 },
    });
    // The signal is bounded and value-free.
    expect(Object.isFrozen(signal)).toBe(true);
    expect(JSON.stringify(signal)).not.toContain("learner@example.com");
    expect(signal.fields).toBeUndefined();
  });

  it("does not flag bulk access below the threshold", async () => {
    const { logger, anomalies } = makeHarness({
      thresholds: { bulkFieldCount: 10, bulkResourceCount: 5 },
    });

    await logger.record({
      actorId: "actor-4",
      purpose: "view",
      resourceType: "user",
      resourceId: "u-4",
      fields: ["email", "phone"],
      decision: "allowed",
    });
    expect(anomalies).toHaveLength(0);
  });

  it("flags repeated denials from the same actor", async () => {
    const { logger, anomalies } = makeHarness({
      thresholds: { denialCount: 2 },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await logger.record({
          actorId: "actor-5",
          purpose: "probe",
          resourceType: "user",
          resourceId: "u-5",
          fields: ["password"],
          decision: "denied",
        });
      } catch (error) {
        expect(error).toBeInstanceOf(SensitiveAccessDeniedError);
      }
    }

    expect(anomalies.map(({ signal }) => signal.type)).toContain("repeated_denials");
  });

  it("detects anomalies as a pure function over a supplied event list", () => {
    const events = [
      { actorId: "a", resourceType: "user", resourceId: "1", fields: ["email"], decision: "allowed", at: NOW.toISOString() },
      { actorId: "a", resourceType: "user", resourceId: "2", fields: ["phone"], decision: "allowed", at: NOW.toISOString() },
    ];
    const signals = detectAccessAnomalies(events, {
      thresholds: { bulkResourceCount: 1, windowMs: 60_000 },
      now: NOW,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("bulk_access");
    expect(signals[0].resourceCount).toBe(2);
  });
});

describe("sensitive redaction", () => {
  it("redacts sensitive keys and strips value-bearing keys recursively", () => {
    const payload = {
      email: "learner@example.com",
      password: "sup3r-secret",
      accessToken: "tok_live_123",
      cardNumber: "4111-1111-1111-1111",
      value: "raw-field-value",
      nested: { apiKey: "k-123", dateOfBirth: "1990-01-01", safe: "kept" },
      rows: [{ secret: "abc", label: "ok" }],
    };

    const redacted = redactSensitivePayload(payload);
    expect(redacted.email).toBe("[redacted]");
    expect(redacted.password).toBe("[redacted]");
    expect(redacted.accessToken).toBe("[redacted]");
    expect(redacted.cardNumber).toBe("[redacted]");
    expect(redacted.value).toBe("[redacted]");
    expect(redacted.nested).toEqual({ apiKey: "[redacted]", dateOfBirth: "[redacted]", safe: "kept" });
    expect(redacted.rows).toEqual([{ secret: "[redacted]", label: "ok" }]);

    const serialized = JSON.stringify(redacted);
    for (const secret of SECRETS) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("raw-field-value");
    expect(serialized).not.toContain("k-123");
  });

  it("keeps only field names when a caller passes name/value objects", async () => {
    expect(
      sanitizeFieldNames([
        { name: "email", value: "learner@example.com" },
        { field: "phone", value: "+15550001111" },
        "fullName",
        "drop me!",
      ]),
    ).toEqual(["[invalid-field-name]", "email", "fullName", "phone"]);

    const event = buildSensitiveAccessEvent({
      actorId: "actor-6",
      purpose: "test",
      resourceType: "user",
      resourceId: "u-6",
      fields: [{ name: "ssn", value: "123-45-6789" }],
      decision: "allowed",
      at: NOW,
    });
    expect(event.fields).toEqual(["ssn"]);
    expect(JSON.stringify(event)).not.toContain("123-45-6789");
  });

  it("rejects an invalid decision before building an event", () => {
    expect(() =>
      buildSensitiveAccessEvent({
        actorId: "a",
        purpose: "p",
        resourceType: "user",
        resourceId: "1",
        fields: [],
        decision: "maybe",
      }),
    ).toThrow(/Invalid sensitive access decision/);
  });
});

describe("audit ledger sink adapter", () => {
  it("forwards a value-free record to the existing audit sink", async () => {
    const appendRecord = vi.fn(async () => {});
    const sink = createAuditLedgerSink({ db: {}, appendRecord });
    const event = buildSensitiveAccessEvent({
      actorId: "actor-7",
      purpose: "support",
      resourceType: "user",
      resourceId: "u-7",
      fields: ["email"],
      decision: "allowed",
      correlationId: "corr-7",
      at: NOW,
    });

    await sink(event);

    expect(appendRecord).toHaveBeenCalledTimes(1);
    const arg = appendRecord.mock.calls[0][0];
    expect(arg.operationId).toBe("sensitive-access:corr-7");
    expect(arg.action).toBe("sensitive_field_access");
    expect(arg.target).toEqual({ type: "user", id: "u-7" });
    expect(arg.result).toEqual({ decision: "allowed", fields: ["email"] });
    expect(JSON.stringify(arg)).not.toContain("learner@example.com");
  });
});
