import { describe, expect, it, vi } from "vitest";
import {
  PermissionExportError,
  REDACTED_VALUE,
  RedactionAction,
  executePermissionAwareExport,
} from "../permissionAwareExport.js";

describe("permission-aware export with field redaction (#1072)", () => {
  const sampleRecords = [
    {
      id: "rec-1",
      email: "learner@eduvault.org",
      walletAddress: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
      amount: 1500,
      internalNotes: "Sensitive support note",
      apiToken: "tok_live_secret_123",
    },
  ];

  const fieldPolicies = {
    email: (actor) => (actor.role === "admin" ? RedactionAction.ALLOW : RedactionAction.MASK),
    walletAddress: (actor) => (actor.role === "admin" ? RedactionAction.ALLOW : RedactionAction.HASH),
    internalNotes: (actor) => (actor.role === "admin" ? RedactionAction.ALLOW : RedactionAction.REDACT),
  };

  it("enforces authentication and permission checks before fetching records", async () => {
    const fetchRecords = vi.fn(async () => sampleRecords);

    await expect(
      executePermissionAwareExport({ actor: null, fetchRecords }),
    ).rejects.toMatchObject({ status: 401, code: "AUTH_UNAUTHENTICATED" });

    await expect(
      executePermissionAwareExport({
        actor: { id: "u1", role: "learner" },
        requiredPermission: "creator:analytics:read",
        fetchRecords,
      }),
    ).rejects.toBeInstanceOf(PermissionExportError);

    expect(fetchRecords).not.toHaveBeenCalled();
  });

  it("redacts, masks, hashes, and strips secret keys according to actor permissions", async () => {
    const creatorExport = await executePermissionAwareExport({
      actor: { id: "c1", role: "creator" },
      requiredPermission: "creator:analytics:read",
      records: sampleRecords,
      fieldPolicies,
      generatedAt: "2026-11-18T12:00:00.000Z",
    });

    expect(creatorExport.records[0].email).toBe("l***r@eduvault.org");
    expect(creatorExport.records[0].walletAddress).toMatch(/^pseudo_[a-f0-9]{16}$/);
    expect(creatorExport.records[0].internalNotes).toBe(REDACTED_VALUE);
    expect(creatorExport.records[0].apiToken).toBe(REDACTED_VALUE);
    expect(creatorExport.redactionSummary.maskedFields).toEqual(["email"]);
    expect(creatorExport.redactionSummary.hashedFields).toEqual(["walletAddress"]);
    expect(creatorExport.redactionSummary.redactedFields).toEqual(["apiToken", "internalNotes"]);

    const adminExport = await executePermissionAwareExport({
      actor: { id: "a1", role: "admin" },
      requiredPermission: "creator:analytics:read",
      records: sampleRecords,
      fieldPolicies,
      generatedAt: "2026-11-18T12:00:00.000Z",
    });

    expect(adminExport.records[0].email).toBe("learner@eduvault.org");
    expect(adminExport.records[0].internalNotes).toBe("Sensitive support note");
    // Secret-like keys are always redacted even for admins
    expect(adminExport.records[0].apiToken).toBe(REDACTED_VALUE);
  });

  it("retries transient fetch failures and fails fast on non-retryable errors", async () => {
    let calls = 0;
    const flakyFetch = vi.fn(async () => {
      calls += 1;
      if (calls < 2) {
        throw Object.assign(new Error("transient timeout"), { code: "STORAGE_UNAVAILABLE", retryable: true });
      }
      return sampleRecords;
    });

    const result = await executePermissionAwareExport({
      actor: { id: "c1", role: "creator" },
      requiredPermission: "creator:analytics:read",
      fetchRecords: flakyFetch,
      fieldPolicies,
      maxRetries: 2,
    });
    expect(result.verification.attempts).toBe(2);
    expect(result.verification.recordCount).toBe(1);

    const permanentFetch = vi.fn(async () => {
      throw Object.assign(new Error("bad query"), { code: "VALIDATION_FAILED", retryable: false });
    });
    await expect(
      executePermissionAwareExport({
        actor: { id: "c1", role: "creator" },
        requiredPermission: "creator:analytics:read",
        fetchRecords: permanentFetch,
        maxRetries: 3,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", retryable: false, attempts: 1 });
    expect(permanentFetch).toHaveBeenCalledTimes(1);
  });
});
