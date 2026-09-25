import { EntitlementProvider } from '../EntitlementProvider.js';

export class EvmEntitlementProvider extends EntitlementProvider {
  constructor() {
    super();
    this.chainType = 'evm';
  }

  async checkAccess({ walletAddress, materialId, chain = 'evm', material, db }) {
    if (!walletAddress || !materialId) {
      return { hasAccess: false, state: 'UNAVAILABLE', source: 'evm-provider' };
    }

    if (db) {
      try {
        const purchase = await db.collection('purchases').findOne({
          buyerAddress: walletAddress.toLowerCase(),
          materialId,
          status: { $in: ['COMPLETED', 'CONFIRMED', 'paid'] }
        });
        if (purchase) {
          return { hasAccess: true, state: 'FINALIZED', source: 'evm-db' };
        }
      } catch (e) {
        // Fallback
      }
    }

    return {
      hasAccess: false,
      state: 'UNLICENSED',
      source: 'evm-provider',
    };
  }

  async grantAccess({ walletAddress, materialId, chain = 'evm', txHash, db }) {
    if (!walletAddress || !materialId) {
      return { success: false, entitlementId: null };
    }
    return {
      success: true,
      entitlementId: `evm:${chain}:${materialId}:${walletAddress}`,
    };
  }

  async revokeAccess({ walletAddress, materialId, chain = 'evm', reason, db }) {
    return { success: true };
  }
}
