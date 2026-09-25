"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/apiClient";

const ENDPOINT = "/api/profile/email-subscriptions";

/** @returns {import('@tanstack/react-query').UseQueryResult} */
export function useEmailSubscriptions({ initialData } = {}) {
  return useQuery({
    queryKey: ["email-subscriptions"],
    queryFn: () => apiClient(ENDPOINT),
    // Pre-populate from server-rendered data while the client fetches.
    initialData: initialData
      ? { emailSubscriptions: initialData, success: true }
      : undefined,
    staleTime: 60 * 1000,
  });
}

/** @returns {import('@tanstack/react-query').UseMutationResult} */
export function useUpdateEmailSubscriptions() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload) =>
      apiClient(ENDPOINT, { method: "PATCH", body: payload }),
    onSuccess: (data) => {
      queryClient.setQueryData(["email-subscriptions"], data);
    },
  });
}
