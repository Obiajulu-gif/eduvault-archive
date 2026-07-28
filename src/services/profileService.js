import { apiClient } from '@/lib/api/apiClient';

export const profileService = {
  getProfile: async (address) => {
    return apiClient(`/api/profile?address=${encodeURIComponent(address)}`);
  },

  createProfile: async (profileData) => {
    return apiClient('/api/profile', { body: profileData });
  },

  updateProfile: async (profileData) => {
    return apiClient('/api/profile', { method: 'PATCH', body: profileData });
  },

  getTopCreators: async () => {
    const data = await apiClient('/api/creators/top');
    return data?.creators || [];
  },

  getDashboardStats: async () => {
    return apiClient('/api/dashboard/stats');
  },
};

