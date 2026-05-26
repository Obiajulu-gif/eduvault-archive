import { apiClient } from '@/lib/api/apiClient';

export const materialService = {
  getMarketplaceMaterials: async (params = {}) => {
    const searchParams = new URLSearchParams(params);
    return apiClient(`/api/market-materials?${searchParams.toString()}`);
  },

  getMaterialDetail: async (id) => {
    return apiClient(`/api/market-materials?id=${id}`);
  },

  getUserMaterials: async () => {
    return apiClient('/api/materials');
  },

  createMaterial: async (materialData) => {
    return apiClient('/api/materials', { body: materialData });
  },

  uploadFile: async (formData) => {
    return apiClient('/api/upload', { 
      body: formData,
      headers: { 'Content-Type': undefined },
      method: 'POST'
    });
  },

  getDownloadUrl: async (id) => {
    return apiClient(`/api/materials/download/${id}`);
  },

  getTrendingMaterials: async (params = {}) => {
    const searchParams = new URLSearchParams({ ...params, sort: 'trending' });
    return apiClient(`/api/market-materials?${searchParams.toString()}`);
  },
};

