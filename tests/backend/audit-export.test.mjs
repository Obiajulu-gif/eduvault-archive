import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AuditExportProfile,
  buildAuditExport,
  verifyAuditExport,
  AuditExportAuthorizationError,
} from "../../src/lib/audit/auditExport.js";

const records = [{
  version: "v1", sequence: 0, actor: "maintainer-1", actorProof: "proof",
  action: "user.role_changed", before: { email: "private@example.com", role: "user" },
  after: { role: "creator" }, password: "should-never-export", recordHash: "hash",
}];

test("audit exports apply deterministic profile redaction and verification metadata", () => {
  const generatedAt = "2026-10-20T12:00:00.000Z";
  const security = buildAuditExport({ actor: { role: "support" }, records, profile: AuditExportProfile.SECURITY, generatedAt });
  const repeat = buildAuditExport({ actor: { role: "support" }, records, profile: AuditExportProfile.SECURITY, generatedAt });
  assert.deepEqual(security, repeat);
  assert.equal(security.records[0].actorProof, "[REDACTED]");
  assert.equal(security.records[0].before.email, "[REDACTED]");
  assert.equal(security.records[0].password, "[REDACTED]");
  assert.equal(verifyAuditExport(security).valid, true);
});

test("full export is allowed only for admins and empty exports remain verifiable", () => {
  assert.throws(() => buildAuditExport({ actor: { role: "support" }, profile: AuditExportProfile.FULL }), AuditExportAuthorizationError);
  const empty = buildAuditExport({ actor: { role: "admin" }, records: [], profile: AuditExportProfile.FULL, generatedAt: "2026-10-20T12:00:00Z" });
  assert.equal(empty.records.length, 0);
  assert.equal(verifyAuditExport(empty).valid, true);
});

test("unauthorized and unauthenticated exports fail before records are read", () => {
  const throwingRecords = { map() { throw new Error("records read"); } };
  assert.throws(() => buildAuditExport({ actor: null, records: throwingRecords }), /Authentication required/);
  assert.throws(() => buildAuditExport({ actor: { role: "user" }, records: throwingRecords }), /authorized staff/);
});
