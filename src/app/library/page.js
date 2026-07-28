"use client";

import LibraryList from "@/components/dashboard/LibraryList";
import { usePurchaseHistory } from "@/hooks/api/usePurchases";

export default function LibraryPage() {
  const { data, isLoading } = usePurchaseHistory();
  const items = data?.purchases || data?.items || (Array.isArray(data) ? data : []);

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <h1 className="text-xl font-bold text-gray-900 mb-1">My Library</h1>
      <p className="text-sm text-gray-500 mb-6">
        Everything you own, sortable and searchable.
      </p>
      <LibraryList items={items} isLoading={isLoading} />
    </div>
  );
}
