"use client";

import { useMarketplaceMaterials } from "@/hooks/api/useMaterials";
import Link from "next/link";
import Image from "next/image";
import { FaHeart } from "react-icons/fa";

function getPreviewImage(material) {
  return material.coverImageUrl || material.thumbnailUrl || material.image || "/images/image1.jpg";
}

export default function RecommendedMaterials({ currentId, subject, category, level, creator }) {
  const { data, isLoading } = useMarketplaceMaterials({
    subject: subject || undefined,
    category: category || undefined,
    pageSize: 12,
  });

  const { data: fallbackData, isLoading: fallbackLoading } = useMarketplaceMaterials({
    sortBy: "popular",
    pageSize: 8,
  });

  const loading = isLoading || fallbackLoading;

  const allItems = [...(data?.items || []), ...(fallbackData?.items || [])];
  
  // Remove duplicates and current item
  const uniqueItems = [];
  const seen = new Set([currentId]);
  
  for (const item of allItems) {
    const id = item._id || item.id;
    if (!seen.has(id)) {
      seen.add(id);
      uniqueItems.push(item);
    }
  }

  // Sort by level match first
  const recommendations = uniqueItems.sort((a, b) => {
    if (level) {
      if (a.level === level && b.level !== level) return -1;
      if (a.level !== level && b.level === level) return 1;
    }
    return 0;
  }).slice(0, 4);

  if (!loading && recommendations.length === 0) {
    return null;
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-foreground mb-4">
        {subject ? `Related Resources in ${subject}` : "Recommended for You"}
      </h2>

      {loading ? (
        <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-white dark:bg-surface-strong border border-gray-200 dark:border-border-strong rounded-xl overflow-hidden animate-pulse">
              <div className="w-full h-32 bg-gray-100 dark:bg-surface-muted" />
              <div className="p-3 space-y-2">
                <div className="h-3 bg-gray-100 dark:bg-surface-muted rounded w-3/4" />
                <div className="h-2 bg-gray-100 dark:bg-surface-muted rounded w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-4">
          {recommendations.map((material) => {
            const materialId = material._id || material.id;
            return (
              <Link
                key={materialId}
                href={`/marketplace/${materialId}`}
                className="bg-white dark:bg-surface-strong border border-gray-200 dark:border-border-strong rounded-xl overflow-hidden shadow-sm hover:shadow-md hover:border-blue-300 transition-all group block"
              >
                <div className="relative w-full h-32 bg-gray-100 dark:bg-surface-muted overflow-hidden">
                  <Image
                    src={getPreviewImage(material)}
                    alt={material.title}
                    fill
                    className="object-cover group-hover:scale-105 transition-transform duration-500"
                  />
                  {material.level && (
                    <span className="absolute top-2 right-2 bg-white/90 dark:bg-surface-strong/90 backdrop-blur-sm text-blue-700 dark:text-blue-300 font-semibold text-[10px] px-2 py-0.5 rounded-md border border-blue-200 dark:border-blue-800 shadow-sm">
                      {material.level.charAt(0).toUpperCase() + material.level.slice(1)}
                    </span>
                  )}
                </div>
                <div className="p-3">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-foreground line-clamp-1 group-hover:text-blue-600 transition-colors">
                    {material.title}
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-muted-foreground mb-2 truncate">
                    by {material.author || material.creator || "Anonymous"}
                  </p>
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1 text-gray-500 dark:text-muted-foreground">
                      <FaHeart className="text-rose-400 w-3 h-3" />
                      {material.likes || 0}
                    </span>
                    <span className="font-bold text-green-600 bg-green-50 dark:bg-green-900/30 px-2 py-0.5 rounded-full">
                      {material.price} {material.currency || "XLM"}
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
