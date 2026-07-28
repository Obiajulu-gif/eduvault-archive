/**
 * Pure helpers for building, serialising and parsing the Soroban deployment
 * manifest produced by `scripts/deploy-soroban.mjs` (#412).
 *
 * The manifest records the contract IDs of a deployment so the Next.js app and
 * the Stellar indexer can be pointed at them. The keys mirror the environment
 * variables documented in `docs/deployment.md`:
 *   - NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID
 *   - NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID
 *
 * These functions contain no I/O and no Stellar CLI calls, so they are unit
 * tested in isolation (see test/integration/soroban-manifest.test.js).
 */

/** Known Stellar network names. */
export const KNOWN_NETWORKS = ["testnet", "futurenet", "mainnet", "local"];

/**
 * Build a manifest object from a deployment result.
 *
 * @param {object} input
 * @param {string} input.network              e.g. "testnet"
 * @param {string} input.materialRegistryId   deployed MaterialRegistry contract ID
 * @param {string} input.purchaseManagerId    deployed PurchaseManager contract ID
 * @param {string} [input.admin]              admin address used for initialize
 * @param {string} [input.treasury]           platform fee recipient address
 * @param {number} [input.platformFeeBps]     platform fee in basis points
 * @param {string} [input.deployer]           deployer public key / identity
 * @param {string} [input.rpcUrl]             Soroban RPC endpoint used
 * @param {string} [input.timestamp]          ISO timestamp (defaults to now)
 * @returns {object} manifest
 */
export function buildManifest(input) {
  const {
    network,
    materialRegistryId,
    purchaseManagerId,
    admin,
    treasury,
    platformFeeBps,
    deployer,
    rpcUrl,
    timestamp,
  } = input || {};

  if (!network || typeof network !== "string") {
    throw new Error("buildManifest: network is required");
  }
  if (!materialRegistryId || typeof materialRegistryId !== "string") {
    throw new Error("buildManifest: materialRegistryId is required");
  }
  if (!purchaseManagerId || typeof purchaseManagerId !== "string") {
    throw new Error("buildManifest: purchaseManagerId is required");
  }

  const manifest = {
    network,
    deployedAt: timestamp || new Date().toISOString(),
    contracts: {
      materialRegistry: materialRegistryId,
      purchaseManager: purchaseManagerId,
    },
  };

  if (deployer) manifest.deployer = deployer;
  if (rpcUrl) manifest.rpcUrl = rpcUrl;

  const config = {};
  if (admin) config.admin = admin;
  if (treasury) config.treasury = treasury;
  if (Number.isFinite(platformFeeBps)) config.platformFeeBps = platformFeeBps;
  if (Object.keys(config).length > 0) manifest.config = config;

  return manifest;
}

/**
 * Serialise a manifest to a pretty-printed JSON string with a trailing newline.
 * @param {object} manifest
 * @returns {string}
 */
export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Parse a manifest JSON string and validate the required shape.
 * @param {string} text
 * @returns {object} manifest
 */
export function parseManifest(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`parseManifest: invalid JSON (${err.message})`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("parseManifest: manifest must be an object");
  }
  if (!parsed.contracts || typeof parsed.contracts !== "object") {
    throw new Error("parseManifest: manifest is missing a contracts section");
  }
  const { materialRegistry, purchaseManager } = parsed.contracts;
  if (!materialRegistry || !purchaseManager) {
    throw new Error(
      "parseManifest: contracts.materialRegistry and contracts.purchaseManager are required",
    );
  }
  return parsed;
}

/**
 * Derive the `.env`-style variable lines that point the app at a deployment.
 * @param {object} manifest
 * @returns {Record<string, string>}
 */
export function manifestToEnvVars(manifest) {
  const contracts = manifest?.contracts || {};
  const vars = {};
  if (contracts.materialRegistry) {
    vars.NEXT_PUBLIC_MATERIAL_REGISTRY_CONTRACT_ID = contracts.materialRegistry;
  }
  if (contracts.purchaseManager) {
    vars.NEXT_PUBLIC_PURCHASE_MANAGER_CONTRACT_ID = contracts.purchaseManager;
  }
  return vars;
}

/**
 * Default on-disk location for a network's manifest, relative to repo root.
 * @param {string} network
 * @returns {string}
 */
export function manifestPathFor(network) {
  return `soroban/deployments/${network}.json`;
}
