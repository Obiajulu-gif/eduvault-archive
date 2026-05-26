import { apiClient } from '@/lib/api/apiClient';

export const profileService = {
  getProfile: async (address) => {
    return apiClient(`/api/profile?address=${address}`);
  },

  createProfile: async (profileData) => {
    return apiClient('/api/profile', { body: profileData });
  },

  getTopCreators: async () => {
    return apiClient('/api/creators/top');
  },

  getDashboardStats: async () => {
    return apiClient('/api/dashboard/stats');
  },
};

