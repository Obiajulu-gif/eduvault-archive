import { describe, it, expect } from "vitest";
import {
  calculateIncidentImpact,
  redactIdentifier,
  SEVERITY_ORDER,
} from "../incident-impact";
import {
  narrowIncident,
  broadIncident,
  noImpact,
  redactedExport,
} from "../fixtures/incident-impact-fixtures";

describe("calculateIncidentImpact", () => {
  it("returns deterministic results for a narrow incident", () => {
    const report = calculateIncidentImpact(narrowIncident.input);
    expect(report.internal.severity).toBe(narrowIncident.expected.severity);
    expect(report.internal.counts).toEqual(narrowIncident.expected.counts);
    expect(report.internal.affectedUsers).toEqual(["user-alice"]);
    expect(report.internal.affectedRecords).toEqual(["rec-101"]);
    expect(report.internal.affectedOperations).toEqual(["download"]);
  });

  it("returns deterministic results for a broad incident", () => {
    const report = calculateIncidentImpact(broadIncident.input);
    expect(report.internal.severity).toBe(broadIncident.expected.severity);
    expect(report.internal.counts).toEqual(broadIncident.expected.counts);
    expect(report.internal.affectedUsers).toEqual([
      "user-alice",
      "user-bob",
      "user-carol",
    ]);
    expect(report.internal.affectedRecords).toEqual(["rec-201", "rec-202", "rec-203"]);
    expect(report.internal.affectedOperations).toEqual(["publish", "purchase"]);
  });

  it("returns zero impact when events fall outside the window", () => {
    const report = calculateIncidentImpact(noImpact.input);
    expect(report.internal.severity).toBe(noImpact.expected.severity);
    expect(report.internal.counts).toEqual(noImpact.expected.counts);
    expect(report.internal.affectedUsers).toEqual([]);
    expect(report.internal.affectedRecords).toEqual([]);
    expect(report.internal.affectedOperations).toEqual([]);
  });

  it("separates internal and shareable fields and redacts identifiers", () => {
    const report = calculateIncidentImpact(redactedExport.input);
    expect(report.internal.severity).toBe(redactedExport.expected.severity);
    expect(report.internal.counts).toEqual(redactedExport.expected.counts);
    expect(report.internal.affectedUsers).toEqual(["user-eve", "user-frank"]);
    expect(report.shareable.affectedUsers).toEqual([
      redactIdentifier("user-eve"),
      redactIdentifier("user-frank"),
    ]);
    expect(report.shareable.affectedRecords).toEqual([
      redactIdentifier("rec-401"),
      redactIdentifier("rec-402"),
    ]);
    expect(report.shareable.affectedOperations).toEqual(["settlement", "wallet_auth"]);
    expect(report.shareable.incidentId).toBe(redactIdentifier("inc-r004"));
    expect(report.shareable.incidentId).not.toContain("inc-r004");
  });

  it("produces stable output across repeated calls", () => {
    const a = calculateIncidentImpact(broadIncident.input);
    const b = calculateIncidentImpact(broadIncident.input);
    expect(a).toEqual(b);
  });

  it("deduplicates identifiers and operations", () => {
    const report = calculateIncidentImpact({
      incidentId: "inc-dup",
      severity: "low",
      affectedUsers: ["user-a", "user-a"],
      affectedRecords: ["rec-1", "rec-1"],
      affectedOperations: ["download", "download"],
    });
    expect(report.internal.affectedUsers).toEqual(["user-a"]);
    expect(report.internal.affectedRecords).toEqual(["rec-1"]);
    expect(report.internal.affectedOperations).toEqual(["download"]);
  });

  it("raises severity for sensitive operations", () => {
    const report = calculateIncidentImpact({
      incidentId: "inc-sens",
      severity: "low",
      affectedOperations: ["settlement"],
    });
    expect(report.internal.severity).toBe("high");
  });

  it("exposes the severity order constant", () => {
    expect(SEVERITY_ORDER).toEqual(["none", "low", "medium", "high", "critical"]);
  });
});
