"use client";

import Link from "next/link";
import Image from "next/image";
import { FaHistory, FaTrash } from "react-icons/fa";
import { useRecentlyViewed } from "@/hooks/useRecentlyViewed";
import ClearRecentlyViewedButton from "@/components/materials/ClearRecentlyViewedButton";
import { motion } from "framer-motion";

function getPreviewImage(material) {
  return material.coverImageUrl || material.thumbnailUrl || material.image || "/images/image1.jpg";
}

export default function RecentlyViewedMaterials() {
  const { items, isLoading, removeRecentlyViewed } = useRecentlyViewed();

  if (isLoading || items.length === 0) {
    return null;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="mb-6"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FaHistory className="text-indigo-500 text-sm" />
          <h2 className="text-sm font-bold text-gray-800">Recently Viewed</h2>
        </div>
        <ClearRecentlyViewedButton className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-semibold text-gray-500 transition hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500" />
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2 hide-scrollbar">
        {items.slice(0, 6).map((material) => {
          const materialId = material._id || material.id;
          return (
            <div
              key={materialId}
              className="group relative flex-shrink-0 w-40 bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm hover:shadow-md hover:border-indigo-200 transition-all"
            >
              <Link
                href={`/marketplace/${materialId}`}
                className="block"
                aria-label={`Open ${material.title}`}
              >
                <div className="relative w-full h-20 bg-gray-100 overflow-hidden">
                  <Image
                    src={getPreviewImage(material)}
                    alt={material.title}
                    fill
                    className="object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                </div>
                <div className="p-2">
                  <h3 className="text-xs font-semibold text-gray-900 line-clamp-1 transition-colors group-hover:text-indigo-600">
                    {material.title}
                  </h3>
                  <div className="mt-1 flex items-center justify-between text-[10px]">
                    <span className="max-w-[60%] truncate text-gray-500">
                      {material.subject || "Material"}
                    </span>
                    <span className="font-bold text-green-600">
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
                className="absolute right-2 top-2 rounded-full bg-white/90 p-1.5 text-gray-500 transition hover:bg-white hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
              >
                <FaTrash className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}
