"use client";

import Image from "next/image";
import { FaHistory, FaTrash } from "react-icons/fa";
import { useRecentlyViewed } from "@/hooks/useRecentlyViewed";
import ClearRecentlyViewedButton from "@/components/materials/ClearRecentlyViewedButton";
import Link from "next/link";

export default function RecentlyViewedSection() {
  const { items, isLoading, removeRecentlyViewed } = useRecentlyViewed();

  if (!isLoading && items.length === 0) {
    return null;
  }

  return (
    <div className="p-6 bg-white border border-gray-100 rounded-xl shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FaHistory className="text-indigo-500" />
          <h3 className="font-bold text-gray-900">Recently Viewed</h3>
        </div>
        {!isLoading ? (
          <ClearRecentlyViewedButton className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold text-gray-500 transition hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500" />
        ) : null}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex gap-3 items-start animate-pulse">
              <div className="w-12 h-14 bg-gray-100 rounded-md" />
              <div className="flex-1 space-y-1 py-1">
                <div className="h-3 bg-gray-100 rounded w-3/4" />
                <div className="h-2 bg-gray-100 rounded w-1/3" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {items.slice(0, 4).map((material) => {
            const materialId = material._id || material.id;
            return (
              <div key={materialId} className="group relative -mx-2 rounded-lg p-2 transition-colors hover:bg-gray-50">
                <Link
                  href={`/marketplace/${materialId}`}
                  className="flex items-start gap-3"
                  aria-label={`Open ${material.title}`}
                >
                  <div className="relative flex h-14 w-12 flex-shrink-0 items-center justify-center overflow-hidden rounded-md border border-indigo-100/50 bg-gradient-to-br from-indigo-100 to-blue-50">
                    {material.coverImageUrl || material.thumbnailUrl || material.image ? (
                      <Image
                        src={material.coverImageUrl || material.thumbnailUrl || material.image}
                        alt={material.title}
                        fill
                        className="object-cover"
                      />
                    ) : (
                      <span className="text-[8px] font-bold uppercase tracking-wider text-indigo-400">Note</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 py-1">
                    <h4 className="truncate text-sm font-semibold text-gray-900 transition-colors group-hover:text-indigo-600">
                      {material.title}
                    </h4>
                    <div className="mt-1 flex items-center justify-between text-xs">
                      <span className="max-w-[60%] truncate text-gray-500">
                        {material.subject || "Material"}
                      </span>
                      <span className="rounded-full bg-green-50 px-1.5 py-0.5 text-[10px] font-bold text-green-600">
                        {material.price} XLM
                      </span>
                    </div>
                  </div>
                </Link>
                <button
                  type="button"
                  onClick={() => removeRecentlyViewed(materialId)}
                  aria-label={`Remove ${material.title} from recently viewed`}
                  title="Remove from recently viewed"
                  className="absolute right-2 top-2 rounded-full bg-white/90 p-1.5 text-gray-400 transition hover:bg-white hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                >
                  <FaTrash className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
