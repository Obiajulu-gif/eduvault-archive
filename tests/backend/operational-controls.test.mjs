import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryDedupeKey, evaluatePolicyDryRun } from "../../src/lib/operations/operationalControls.js";
import { redactSensitive, runWithCorrelationId, getCorrelationId } from "../../src/lib/monitoring/telemetry.js";

test("policy dry-run returns bounded affected-record previews without writes", async () => {
  const result = await evaluatePolicyDryRun({
    policyType: "MARKETPLACE_FEE",
    currentPolicy: { platformFeeBps: 500 },
    proposedPolicy: { platformFeeBps: 600 },
    dataSource: { materials: [{ _id: "m-1" }], purchases: [{ purchaseId: "p-1", amount: 10, creator: "c-1" }] },
    actor: { walletAddress: "G..." },
    maxPreviewRecords: 1,
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.writesPerformed, 0);
  assert.equal(result.affectedRecords.count, 2);
  assert.equal(result.affectedRecords.sample.length, 1);
});

test("delivery keys are stable across retries and correlation survives async work", async () => {
  assert.equal(deliveryDedupeKey({ channel: "webhook", eventType: "purchase.completed", sourceId: "p-1" }), "webhook:purchase.completed:p-1:v1");
  assert.equal(deliveryDedupeKey({ channel: "webhook", eventType: "purchase.completed", sourceId: "p-1" }), deliveryDedupeKey({ channel: "webhook", eventType: "purchase.completed", sourceId: "p-1" }));
  await runWithCorrelationId("corr-1", async () => {
    await Promise.resolve();
    assert.equal(getCorrelationId(), "corr-1");
  });
});

test("redaction removes sensitive fields and masks secrets in nested output", () => {
  const redacted = redactSensitive({ authorization: "Bearer secret", nested: { email: "person@example.com", safe: "ok" } });
  assert.equal(redacted.authorization, "[REDACTED]");
  assert.equal(redacted.nested.email, "[REDACTED]");
  assert.equal(redacted.nested.safe, "ok");
});
