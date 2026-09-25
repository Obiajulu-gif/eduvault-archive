"use client";

import { useQuery } from "@tanstack/react-query";

export function useMaterialHistory(id) {
  return useQuery({
    queryKey: ["material-history", id],
    queryFn: async () => {
      const res = await fetch(`/api/materials/history?id=${id}`);
      if (!res.ok) {
        throw new Error("Failed to fetch revision history");
      }
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    enabled: !!id,
    staleTime: 5 * 60 * 1000,
  });
}
