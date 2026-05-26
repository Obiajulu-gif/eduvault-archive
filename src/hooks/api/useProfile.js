import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { profileService } from '@/services/profileService';
import { queryKeys } from '@/lib/query/queryKeys';

export function useUserProfile(address) {
  return useQuery({
    queryKey: queryKeys.profile.detail(address),
    queryFn: () => profileService.getProfile(address),
    enabled: !!address,
  });
}

export function useCreateProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: profileService.createProfile,
    onSuccess: (data) => {
      if (data.user?.walletAddress) {
        queryClient.invalidateQueries({ 
          queryKey: queryKeys.profile.detail(data.user.walletAddress) 
        });
      }
    },
  });
}

export function useTopCreators() {
  return useQuery({
    queryKey: queryKeys.profile.top(),
    queryFn: () => profileService.getTopCreators(),
    staleTime: 15 * 60 * 1000,
  });
}

export function useDashboardStats() {
  return useQuery({
    queryKey: queryKeys.dashboard.stats(),
    queryFn: () => profileService.getDashboardStats(),
    staleTime: 5 * 60 * 1000,
  });
}

