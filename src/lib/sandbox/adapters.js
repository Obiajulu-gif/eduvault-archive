import { createHash } from "node:crypto";
import { SANDBOX_FIXTURES, SANDBOX_SCENARIOS, getSandboxScenario } from "./fixtures.js";

export function isSandboxMode(env = process.env) {
  return env.EDUVAULT_SANDBOX === "true";
}

function fixtureCid(kind, value) {
  const digest = createHash("sha256").update(`${kind}:${value}`).digest("hex");
  return `bafybeisandbox${digest.slice(0, 32)}`;
}

async function fileFingerprint(file) {
  const bytes = Buffer.from(await file.arrayBuffer());
  return `${file.name}:${file.type}:${bytes.toString("base64")}`;
}

/** Create a Pinata-compatible adapter with no network or credential access. */
export function createSandboxStorageAdapter({ scenario = getSandboxScenario() } = {}) {
  const failIfRequested = () => {
    if (scenario === SANDBOX_SCENARIOS.STORAGE_FAILURE) {
      throw new Error("Sandbox storage fixture: pinning failed");
    }
  };
  const pin = async (kind, value) => {
    failIfRequested();
    return { cid: fixtureCid(kind, value) };
  };

  return {
    upload: { public: {
      file: async (file) => pin("file", await fileFingerprint(file)),
      json: async (value) => pin("json", JSON.stringify(value)),
    } },
    gateways: { public: {
      convert: async (cid) => `${SANDBOX_FIXTURES.gateway}/${cid}`,
    } },
  };
}

/** Return the deterministic chain result for a sandbox checkout. */
export function getSandboxTransactionStatus(hash, { scenario = getSandboxScenario() } = {}) {
  if (!hash) return "not_found";
  if (scenario === SANDBOX_SCENARIOS.TRANSACTION_PENDING) return "pending";
  if (scenario === SANDBOX_SCENARIOS.TRANSACTION_FAILED) return "failed";
  return "confirmed";
}

/** Return a deterministic trustline result without loading a Stellar account. */
export function getSandboxTrustline(assetCode, issuerAddress, { scenario = getSandboxScenario() } = {}) {
  const issuer = assetCode === "XLM" ? null : (issuerAddress || SANDBOX_FIXTURES.issuer);
  if (scenario === SANDBOX_SCENARIOS.MISSING_TRUSTLINE) {
    return {
      hasTrustline: false,
      issuer,
      instructions: {
        message: `Sandbox fixture: add a trustline for ${assetCode} before checkout.`,
        steps: ["Switch EDUVAULT_SANDBOX_SCENARIO to success to simulate an active trustline."],
        assetCode,
        issuer,
      },
    };
  }
  return { hasTrustline: true, balance: SANDBOX_FIXTURES.balance, issuer };
}
