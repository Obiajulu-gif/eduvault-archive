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
    queryFn: () => purchaseService.checkEntitlement(materialId),
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
           queryKey: ['purchases', 'entitlement', variables.materialId] 
         });
      }
    },
  });
}
