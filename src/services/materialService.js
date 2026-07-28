import { apiClient } from '@/lib/api/apiClient';
import { buildQueryParams } from '@/lib/api/queryParams';

export const materialService = {
  getMarketplaceMaterials: async (params = {}) => {
    const searchParams = buildQueryParams(params);
    return apiClient(`/api/market-materials?${searchParams.toString()}`);
  },

  getMaterialDetail: async (id) => {
    return apiClient(`/api/market-materials?id=${encodeURIComponent(id)}`);
  },

  getMaterialFeedback: async (id) => {
    return apiClient(`/api/materials/${id}/feedback`);
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

  updateMaterial: async (id, updateData) => {
    return apiClient(`/api/materials?id=${id}`, {
      method: 'PUT',
      body: updateData,
    });
  },

  submitMaterialFeedback: async (id, feedbackData) => {
    return apiClient(`/api/materials/${id}/feedback`, {
      method: 'POST',
      body: feedbackData,
    });
  },

  getMaterialHistory: async (id) => {
    return apiClient(`/api/materials/history?id=${id}`);
  },

  reportMaterial: async (id, reportData) => {
    return apiClient(`/api/materials/${id}/report`, {
      method: 'POST',
      body: reportData,
    });
  },

  getTrendingMaterials: async (params = {}) => {
    const searchParams = buildQueryParams({ ...params, sort: 'trending' });
    return apiClient(`/api/market-materials?${searchParams.toString()}`);
  },
};

