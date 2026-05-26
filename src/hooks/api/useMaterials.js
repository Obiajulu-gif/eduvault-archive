import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { materialService } from '@/services/materialService';
import { queryKeys } from '@/lib/query/queryKeys';

export function useMarketplaceMaterials(params = {}) {
  return useQuery({
    queryKey: queryKeys.materials.marketplace(params),
    queryFn: () => materialService.getMarketplaceMaterials(params),
    staleTime: 5 * 60 * 1000,
  });
}

export function useTrendingMaterials(params = {}) {
  return useQuery({
    queryKey: queryKeys.materials.trending(params),
    queryFn: () => materialService.getTrendingMaterials(params),
    staleTime: 10 * 60 * 1000,
  });
}


export function useMaterialDetail(id) {
  return useQuery({
    queryKey: queryKeys.materials.detail(id),
    queryFn: () => materialService.getMaterialDetail(id),
    enabled: !!id,
  });
}

export function useUserMaterials() {
  return useQuery({
    queryKey: queryKeys.materials.all,
    queryFn: () => materialService.getUserMaterials(),
  });
}

export function useUploadFile() {
  return useMutation({
    mutationFn: materialService.uploadFile,
  });
}

export function useCreateMaterial() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: materialService.createMaterial,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.materials.all });
      queryClient.invalidateQueries({ queryKey: ['materials', 'marketplace'] });
    },
  });
}

export function useDownloadMaterial() {
  return useMutation({
    mutationFn: (id) => materialService.getDownloadUrl(id),
  });
}
