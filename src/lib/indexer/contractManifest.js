import { Networks } from "@stellar/stellar-sdk";

/**
 * Allowlisted contract deployments per network (#7).
 *
 * The indexer must reject events from a contract id / network passphrase
 * combination it doesn't recognize, rather than trusting whatever a
 * misconfigured RPC endpoint hands back. Contract ids are read from the
 * same env vars the frontend chain config uses
 * (`src/lib/config/chain.js`), so a single deployment is the source of
 * truth for both.
 */

function buildManifest() {
  const testnetRegistry = process.env.MATERIAL_REGISTRY_CONTRACT_ID_TESTNET
    || process.env.NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID
    || "";
  const testnetPurchase = process.env.PURCHASE_MANAGER_CONTRACT_ID_TESTNET
    || process.env.NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID
    || "";
  const testnetTrustlessWork = process.env.TRUSTLESS_WORK_CONTRACT_ID_TESTNET
    || process.env.NEXT_PUBLIC_TRUSTLESS_WORK_CONTRACT_ID
    || "";
  const mainnetRegistry = process.env.MATERIAL_REGISTRY_CONTRACT_ID_MAINNET || "";
  const mainnetPurchase = process.env.PURCHASE_MANAGER_CONTRACT_ID_MAINNET || "";
  const mainnetTrustlessWork = process.env.TRUSTLESS_WORK_CONTRACT_ID_MAINNET || "";

  return {
    [Networks.TESTNET]: {
      materialRegistry: testnetRegistry,
      purchaseManager: testnetPurchase,
      trustlessWork: testnetTrustlessWork,
    },
    [Networks.PUBLIC]: {
      materialRegistry: mainnetRegistry,
      purchaseManager: mainnetPurchase,
      trustlessWork: mainnetTrustlessWork,
    },
  };
}

export function getContractManifest(networkPassphrase, overrides) {
  const manifest = overrides || buildManifest();
  return manifest[networkPassphrase] || null;
}

/**
 * Returns the schema contract key ("materialRegistry" | "purchaseManager")
 * that `contractId` is allowlisted under for `networkPassphrase`, or `null`
 * if it isn't a recognized deployment.
 */
export function resolveContractKind(contractId, networkPassphrase, overrides) {
  if (!contractId) return null;
  const deployment = getContractManifest(networkPassphrase, overrides);
  if (!deployment) return null;
  if (deployment.materialRegistry && deployment.materialRegistry === contractId) {
    return "materialRegistry";
  }
  if (deployment.purchaseManager && deployment.purchaseManager === contractId) {
    return "purchaseManager";
  }
  if (deployment.trustlessWork && deployment.trustlessWork === contractId) {
    return "trustlessWork";
  }
  return null;
}
