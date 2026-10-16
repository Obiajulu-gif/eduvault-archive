/**
 * Deterministic responses used by local sandbox adapters. These values are
 * intentionally non-routable and must never be submitted to Stellar or IPFS.
 */
export const SANDBOX_SCENARIOS = Object.freeze({
  SUCCESS: "success",
  STORAGE_FAILURE: "storage_failure",
  MISSING_TRUSTLINE: "missing_trustline",
  TRANSACTION_PENDING: "transaction_pending",
  TRANSACTION_FAILED: "transaction_failed",
});

export const SANDBOX_FIXTURES = Object.freeze({
  gateway: "https://sandbox.eduvault.invalid/ipfs",
  balance: "250.0000000",
  issuer: "GSANDBOXASSETISSUER000000000000000000000000000000000000000000",
  transactionHash: "sandbox-transaction-confirmed",
});

export function getSandboxScenario(value = process.env.EDUVAULT_SANDBOX_SCENARIO) {
  return Object.values(SANDBOX_SCENARIOS).includes(value)
    ? value
    : SANDBOX_SCENARIOS.SUCCESS;
}
