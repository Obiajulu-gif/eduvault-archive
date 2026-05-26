import { useQuery } from '@tanstack/react-query';
import { purchaseService } from '@/services/purchaseService';
import { queryKeys } from '@/lib/query/queryKeys';
import { useAccount } from 'wagmi';

/**
 * Hook to check if the current user has entitlement to a specific material.
 * Supports both authenticated checks and eventual on-chain sync.
 */
export function useEntitlement(materialId) {
  const { address } = useAccount();

  return useQuery({
    queryKey: queryKeys.purchases.entitlement(materialId, address),
    queryFn: () => purchaseService.checkEntitlement(materialId),
    enabled: !!materialId && !!address,
    staleTime: 30 * 60 * 1000, // Entitlements don't change often
    retry: 1,
  });
}

/**
 * Hook to check multiple material entitlements at once (useful for marketplace listings)
 */
export function useBatchEntitlements(materialIds = []) {
  const { address } = useAccount();

  return useQuery({
    queryKey: ['purchases', 'entitlements', 'batch', materialIds, address],
    queryFn: () => purchaseService.checkBatchEntitlements(materialIds),
    enabled: materialIds.length > 0 && !!address,
    staleTime: 30 * 60 * 1000,
  });
}
