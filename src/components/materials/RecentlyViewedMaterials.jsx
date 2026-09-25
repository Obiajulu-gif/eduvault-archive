"use client";

import Link from "next/link";
import Image from "next/image";
import { FaHistory, FaHeart } from "react-icons/fa";
import { useRecentlyViewed } from "@/hooks/useRecentlyViewed";
import { useMarketplaceMaterials } from "@/hooks/api/useMaterials";
import { motion } from "framer-motion";

function getPreviewImage(material) {
  return material.coverImageUrl || material.thumbnailUrl || material.image || "/images/image1.jpg";
}

export default function RecentlyViewedMaterials() {
  const { items, isLoading, ids } = useRecentlyViewed();

  if (!isLoading && items.length === 0) {
    return null;
  }

  if (isLoading) {
    return null;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="mb-6"
    >
      <div className="flex items-center gap-2 mb-3">
        <FaHistory className="text-indigo-500 text-sm" />
        <h2 className="text-sm font-bold text-gray-800 dark:text-foreground">Recently Viewed</h2>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2 hide-scrollbar">
        {items.slice(0, 6).map((material) => {
          const materialId = material._id || material.id;
          return (
            <Link
              key={materialId}
              href={`/marketplace/${materialId}`}
              className="flex-shrink-0 w-40 bg-white dark:bg-surface-strong border border-gray-200 dark:border-border-strong rounded-xl overflow-hidden shadow-sm hover:shadow-md hover:border-indigo-200 transition-all group"
            >
              <div className="relative w-full h-20 bg-gray-100 dark:bg-surface-muted overflow-hidden">
                <Image
                  src={getPreviewImage(material)}
                  alt={material.title}
                  fill
                  className="object-cover group-hover:scale-105 transition-transform duration-500"
                />
              </div>
              <div className="p-2">
                <h3 className="text-xs font-semibold text-gray-900 dark:text-foreground line-clamp-1 group-hover:text-indigo-600 transition-colors">
                  {material.title}
                </h3>
                <div className="flex items-center justify-between mt-1 text-[10px]">
                  <span className="text-gray-500 dark:text-muted-foreground truncate max-w-[60%]">
                    {material.subject || "Material"}
                  </span>
                  <span className="font-bold text-green-600">
                    {material.price} XLM
                  </span>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </motion.div>
  );
}
