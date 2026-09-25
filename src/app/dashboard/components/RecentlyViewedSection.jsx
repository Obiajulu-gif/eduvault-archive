"use client";
import Image from "next/image";
import { FaHistory, FaHeart } from "react-icons/fa";
import { useRecentlyViewed } from "@/hooks/useRecentlyViewed";
import Link from "next/link";

export default function RecentlyViewedSection() {
  const { items, isLoading } = useRecentlyViewed();

  if (!isLoading && items.length === 0) {
    return null;
  }

  return (
    <div className="p-6 bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <FaHistory className="text-indigo-500" />
        <h3 className="font-bold text-gray-900 dark:text-gray-100">Recently Viewed</h3>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex gap-3 items-start animate-pulse">
              <div className="w-12 h-14 bg-gray-100 dark:bg-gray-800 rounded-md" />
              <div className="flex-1 space-y-1 py-1">
                <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded w-3/4" />
                <div className="h-2 bg-gray-100 dark:bg-gray-800 rounded w-1/3" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {items.slice(0, 4).map((material) => {
            const materialId = material._id || material.id;
            return (
              <Link
                key={materialId}
                href={`/marketplace/${materialId}`}
                className="flex gap-3 items-start group hover:bg-gray-50 dark:hover:bg-gray-800 p-2 -mx-2 rounded-lg transition-colors block"
              >
                <div className="w-12 h-14 bg-gradient-to-br from-indigo-100 to-blue-50 rounded-md flex items-center justify-center border border-indigo-100/50 flex-shrink-0 overflow-hidden relative">
                  {material.coverImageUrl || material.thumbnailUrl || material.image ? (
                    <Image
                      src={material.coverImageUrl || material.thumbnailUrl || material.image}
                      alt={material.title}
                      fill
                      className="object-cover"
                    />
                  ) : (
                    <span className="text-[8px] text-indigo-400 font-bold uppercase tracking-wider">Note</span>
                  )}
                </div>
                <div className="flex-1 min-w-0 py-1">
                  <h4 className="font-semibold text-sm text-gray-900 dark:text-gray-100 truncate group-hover:text-indigo-600 transition-colors">
                    {material.title}
                  </h4>
                  <div className="flex items-center justify-between text-xs mt-1">
                    <span className="text-gray-500 dark:text-gray-400 truncate max-w-[60%]">
                      {material.subject || "Material"}
                    </span>
                    <span className="font-bold text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/40 px-1.5 py-0.5 rounded-full text-[10px]">
                      {material.price} XLM
                    </span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
