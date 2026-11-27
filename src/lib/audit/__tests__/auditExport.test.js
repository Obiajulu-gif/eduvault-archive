import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  AuditExportProfile,
  AuditExportAuthorizationError,
  redactAuditRecord,
  buildAuditExport,
  verifyAuditExport,
} from "../../audit/auditExport.js";

const ADMIN_USER = { userId: "admin-001", role: "admin" };
const SECURITY_USER = { userId: "sec-001", role: "security" };
const OPS_USER = { userId: "ops-001", role: "ops" };
const PRIVACY_USER = { userId: "privacy-001", role: "auditor" };

function makeRecord(overrides = {}) {
  return {
    id: "rec-001",
    timestamp: new Date("2024-01-15T10:30:00Z"),
    actor: "user-123",
    actorEmail: "alice@example.com",
    action: "material.view",
    target: "material-456",
    targetWallet: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    metadata: { ip: "192.168.1.1", sessionId: "sess-789" },
    secretApiKey: "sk_live_supersecret",
    ...overrides,
  };
}

describe("redactAuditRecord — FULL profile", () => {
  it("preserves all fields for FULL profile", () => {
    const record = makeRecord();
    const result = redactAuditRecord(record, AuditExportProfile.FULL);
    expect(result.actor).toBe(record.actor);
    expect(result.actorEmail).toBe(record.actorEmail);
    expect(result.metadata?.ip).toBe("192.168.1.1");
  });

  it("strips SECRET_KEY pattern fields regardless of profile", () => {
    const record = makeRecord();
    const result = redactAuditRecord(record, AuditExportProfile.FULL);
    expect(result.secretApiKey).toBeUndefined();
  });
});

describe("redactAuditRecord — SECURITY profile", () => {
  it("retains actor, action, target, and timestamp", () => {
    const record = makeRecord();
    const result = redactAuditRecord(record, AuditExportProfile.SECURITY);
    expect(result.actor).toBeTruthy();
    expect(result.action).toBe("material.view");
    expect(result.target).toBe("material-456");
    expect(result.timestamp).toBeTruthy();
  });

  it("omits or redacts PII email field", () => {
    const record = makeRecord();
    const result = redactAuditRecord(record, AuditExportProfile.SECURITY);
    expect(result.actorEmail == null || result.actorEmail === "[REDACTED]").toBe(true);
  });
});

describe("redactAuditRecord — OPERATIONS profile", () => {
  it("retains action and timestamp", () => {
    const record = makeRecord();
    const result = redactAuditRecord(record, AuditExportProfile.OPERATIONS);
    expect(result.action).toBe("material.view");
    expect(result.timestamp).toBeTruthy();
  });

  it("omits direct user identifiers", () => {
    const record = makeRecord();
    const result = redactAuditRecord(record, AuditExportProfile.OPERATIONS);
    expect(result.actorEmail == null || result.actorEmail === "[REDACTED]").toBe(true);
  });
});

describe("redactAuditRecord — PRIVACY profile", () => {
  it("omits wallet addresses", () => {
    const record = makeRecord();
    const result = redactAuditRecord(record, AuditExportProfile.PRIVACY);
    expect(result.targetWallet == null || result.targetWallet === "[REDACTED]").toBe(true);
  });

  it("omits IP addresses from metadata", () => {
    const record = makeRecord();
    const result = redactAuditRecord(record, AuditExportProfile.PRIVACY);
    const ip = result.metadata?.ip;
    expect(ip == null || ip === "[REDACTED]").toBe(true);
  });

  it("retains non-PII fields", () => {
    const record = makeRecord();
    const result = redactAuditRecord(record, AuditExportProfile.PRIVACY);
    expect(result.action).toBe("material.view");
  });
});

describe("redactAuditRecord — SECRET_KEY regex", () => {
  it("strips field whose key contains 'secret'", () => {
    const record = makeRecord({ secretToken: "token-xyz" });
    const result = redactAuditRecord(record, AuditExportProfile.FULL);
    expect(result.secretToken).toBeUndefined();
  });

  it("strips field whose key contains 'apiKey'", () => {
    const record = makeRecord({ apiKey: "key-123" });
    const result = redactAuditRecord(record, AuditExportProfile.FULL);
    expect(result.apiKey).toBeUndefined();
  });

  it("strips field whose key contains 'password'", () => {
    const record = makeRecord({ adminPassword: "hunter2" });
    const result = redactAuditRecord(record, AuditExportProfile.FULL);
    expect(result.adminPassword).toBeUndefined();
  });
});

describe("buildAuditExport", () => {
  it("throws AuditExportAuthorizationError for non-admin requesting FULL", async () => {
    await expect(
      buildAuditExport({ records: [makeRecord()], profile: AuditExportProfile.FULL, requestedBy: OPS_USER })
    ).rejects.toThrow(AuditExportAuthorizationError);
  });

  it("allows admin to request FULL profile", async () => {
    const result = await buildAuditExport({
      records: [makeRecord()],
      profile: AuditExportProfile.FULL,
      requestedBy: ADMIN_USER,
    });
    expect(result.records).toHaveLength(1);
    expect(result.profile).toBe(AuditExportProfile.FULL);
  });

  it("includes contentHash and recordCount in export", async () => {
    const result = await buildAuditExport({
      records: [makeRecord(), makeRecord({ id: "rec-002" })],
      profile: AuditExportProfile.SECURITY,
      requestedBy: SECURITY_USER,
    });
    expect(result.contentHash).toBeTruthy();
    expect(result.recordCount).toBe(2);
  });

  it("strips SECRET_KEY fields from every record in the export", async () => {
    const result = await buildAuditExport({
      records: [makeRecord()],
      profile: AuditExportProfile.FULL,
      requestedBy: ADMIN_USER,
    });
    expect(result.records[0].secretApiKey).toBeUndefined();
  });
});

describe("verifyAuditExport", () => {
  it("verifies a freshly built export", async () => {
    const exported = await buildAuditExport({
      records: [makeRecord()],
      profile: AuditExportProfile.OPERATIONS,
      requestedBy: OPS_USER,
    });
    const { valid } = await verifyAuditExport(exported);
    expect(valid).toBe(true);
  });

  it("detects tampered recordCount", async () => {
    const exported = await buildAuditExport({
      records: [makeRecord()],
      profile: AuditExportProfile.OPERATIONS,
      requestedBy: OPS_USER,
    });
    exported.recordCount = 999;
    const { valid } = await verifyAuditExport(exported);
    expect(valid).toBe(false);
  });

  it("detects tampered record contents", async () => {
    const exported = await buildAuditExport({
      records: [makeRecord()],
      profile: AuditExportProfile.OPERATIONS,
      requestedBy: OPS_USER,
    });
    exported.records[0].action = "injected.action";
    const { valid } = await verifyAuditExport(exported);
    expect(valid).toBe(false);
  });
});
