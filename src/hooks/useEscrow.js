import { useQuery } from "@tanstack/react-query";

async function fetchEscrow(escrowId) {
  const res = await fetch(`/api/escrows/${escrowId}`);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error("Failed to fetch escrow");
  }
  return res.json();
}

async function fetchUserEscrows(walletAddress) {
  if (!walletAddress) return [];
  const res = await fetch(`/api/escrows?engager=${walletAddress}`);
  if (!res.ok) {
    throw new Error("Failed to fetch user escrows");
  }
  return res.json();
}

async function fetchEscrowMilestones(escrowId) {
  if (!escrowId) return [];
  const res = await fetch(`/api/escrows/${escrowId}/milestones`);
  if (!res.ok) {
    throw new Error("Failed to fetch milestones");
  }
  return res.json();
}

export function useEscrow(escrowId, { enabled = true, refetchInterval = false } = {}) {
  return useQuery({
    queryKey: ["escrow", escrowId],
    queryFn: () => fetchEscrow(escrowId),
    enabled: enabled && !!escrowId,
    refetchInterval,
  });
}

export function useUserEscrows(walletAddress, { enabled = true } = {}) {
  return useQuery({
    queryKey: ["escrows", "user", walletAddress],
    queryFn: () => fetchUserEscrows(walletAddress),
    enabled: enabled && !!walletAddress,
  });
}

export function useEscrowMilestones(escrowId, { enabled = true, refetchInterval = false } = {}) {
  return useQuery({
    queryKey: ["escrow", escrowId, "milestones"],
    queryFn: () => fetchEscrowMilestones(escrowId),
    enabled: enabled && !!escrowId,
    refetchInterval,
  });
}
