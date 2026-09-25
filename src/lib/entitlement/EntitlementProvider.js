/**
 * Base EntitlementProvider interface defining chain-agnostic access control.
 * All chain backends (EVM, Soroban, etc.) implement this contract.
 */
export class EntitlementProvider {
  getChainType() {
    return this.chainType || 'generic';
  }

  /**
   * Check whether a wallet address holds an active entitlement for a material.
   * @param {object} params
   * @param {string} params.walletAddress
   * @param {string} params.materialId
   * @param {string} [params.chain]
   * @param {object} [params.material]
   * @param {object} [params.db]
   * @returns {Promise<{ hasAccess: boolean, state: string, source: string }>}
   */
  async checkAccess({ walletAddress, materialId, chain, material, db }) {
    throw new Error("EntitlementProvider.checkAccess must be implemented by subclass.");
  }

  /**
   * Grant an entitlement to a wallet address.
   * @param {object} params
   * @param {string} params.walletAddress
   * @param {string} params.materialId
   * @param {string} [params.chain]
   * @param {string} [params.txHash]
   * @param {object} [params.db]
   * @returns {Promise<{ success: boolean, entitlementId: string }>}
   */
  async grantAccess({ walletAddress, materialId, chain, txHash, db }) {
    throw new Error("EntitlementProvider.grantAccess must be implemented by subclass.");
  }

  /**
   * Revoke an entitlement from a wallet address.
   * @param {object} params
   * @param {string} params.walletAddress
   * @param {string} params.materialId
   * @param {string} [params.chain]
   * @param {string} [params.reason]
   * @param {object} [params.db]
   * @returns {Promise<{ success: boolean }>}
   */
  async revokeAccess({ walletAddress, materialId, chain, reason, db }) {
    throw new Error("EntitlementProvider.revokeAccess must be implemented by subclass.");
  }
}
