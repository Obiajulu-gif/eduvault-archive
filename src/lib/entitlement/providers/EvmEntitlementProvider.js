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
        const normalisedAddress = String(walletAddress).trim().toLowerCase();
        const purchase = await db.collection('purchases').findOne({
          buyerAddress: normalisedAddress,
          materialId,
          status: { $in: ['COMPLETED', 'CONFIRMED', 'paid', 'settled', 'completed', 'confirmed'] }
        });
        if (purchase) {
          if (purchase.settlementState && ['Refunded', 'Disputed', 'Expired'].includes(purchase.settlementState)) {
            return { hasAccess: false, state: 'REVOKED', source: 'evm-db' };
          }
          return { hasAccess: true, state: 'FINALIZED', source: 'evm-db' };
        }
      } catch (e) {
        // Fail-safe fall through
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
