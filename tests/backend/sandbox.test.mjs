import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.EDUVAULT_SANDBOX = "true";

const { createSandboxStorageAdapter, getSandboxTransactionStatus, getSandboxTrustline, isSandboxMode } = await import("../../src/lib/sandbox/adapters.js");
const { SANDBOX_SCENARIOS } = await import("../../src/lib/sandbox/fixtures.js");

describe("local sandbox adapters", () => {
  it("is opt-in and pins the same file to a deterministic local CID", async () => {
    assert.equal(isSandboxMode(), true);
    const adapter = createSandboxStorageAdapter();
    const file = new File(["student-owned notes"], "notes.txt", { type: "text/plain" });
    const first = await adapter.upload.public.file(file);
    const second = await adapter.upload.public.file(file);
    assert.deepEqual(first, second);
    assert.equal(await adapter.gateways.public.convert(first.cid), `https://sandbox.eduvault.invalid/ipfs/${first.cid}`);
  });

  it("exposes deterministic success and failure fixtures for checkout", () => {
    assert.equal(getSandboxTransactionStatus("tx"), "confirmed");
    assert.equal(getSandboxTransactionStatus("tx", { scenario: SANDBOX_SCENARIOS.TRANSACTION_PENDING }), "pending");
    assert.equal(getSandboxTransactionStatus("tx", { scenario: SANDBOX_SCENARIOS.TRANSACTION_FAILED }), "failed");
    assert.equal(getSandboxTrustline("USDC").hasTrustline, true);
    assert.equal(getSandboxTrustline("USDC", undefined, { scenario: SANDBOX_SCENARIOS.MISSING_TRUSTLINE }).hasTrustline, false);
  });

  it("simulates a storage failure without a remote call", async () => {
    const adapter = createSandboxStorageAdapter({ scenario: SANDBOX_SCENARIOS.STORAGE_FAILURE });
    await assert.rejects(() => adapter.upload.public.json({ material: "fixture" }), /Sandbox storage fixture/);
  });
});
