import { apiClient } from '@/lib/api/apiClient';

export const purchaseService = {
  createPurchase: async (purchaseData) => {
    return apiClient('/api/purchase', { body: purchaseData });
  },

  checkEntitlement: async (materialId) => {
    return apiClient(`/api/entitlements?materialId=${materialId}`);
  },

  checkBatchEntitlements: async (materialIds) => {
    return apiClient('/api/entitlements/batch', { body: { materialIds } });
  },

  getPurchaseHistory: async () => {
    return apiClient('/api/purchase');
  },
};

