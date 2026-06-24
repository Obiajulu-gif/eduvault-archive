import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { purchaseService } from '@/services/purchaseService';
import { queryKeys } from '@/lib/query/queryKeys';

export function usePurchaseHistory() {
  return useQuery({
    queryKey: queryKeys.purchases.history(),
    queryFn: () => purchaseService.getPurchaseHistory(),
  });
}

export function useCheckEntitlement(materialId, address) {
  return useQuery({
    queryKey: queryKeys.purchases.entitlement(materialId, address),
    queryFn: () => purchaseService.checkEntitlement(materialId, address),
    enabled: !!materialId && !!address,
  });
}

export function useCreatePurchase() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: purchaseService.createPurchase,
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.purchases.all });
      // Invalidate specific entitlement check if materialId is known
      if (variables.materialId) {
        queryClient.invalidateQueries({
          predicate: (query) =>
            Array.isArray(query.queryKey) &&
            query.queryKey[0] === 'purchases' &&
            query.queryKey[1] === 'entitlement' &&
            query.queryKey[2] === variables.materialId,
        });
      }
    },
  });
}

export function useStartAccessRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: purchaseService.startAccessRequest,
    onSuccess: (_data, variables) => {
      if (variables.materialId) {
        queryClient.invalidateQueries({
          predicate: (query) =>
            Array.isArray(query.queryKey) &&
            query.queryKey[0] === 'purchases' &&
            query.queryKey[1] === 'entitlement' &&
            query.queryKey[2] === variables.materialId,
        });
      }
    },
  });
}
