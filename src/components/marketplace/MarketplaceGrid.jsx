"use client";

import { motion } from "framer-motion";
import MaterialCard from "./MaterialCard";
import MaterialCardSkeleton from "./MaterialCardSkeleton";
import PaginationBar from "./PaginationBar";

export default function MarketplaceGrid({
  isLoading, isError, error,
  materials, total, activeSubject, searchQuery,
  cartItems, comparedItems,
  onAddToCart, onAddToComparison,
  onResetFilters, onBrowseAll, onSearchSubject,
  currentPage, totalPages, onPageChange,
}) {
  if (isLoading) {
    return (
      <div aria-live="polite" aria-busy="true" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
        {Array.from({ length: 12 }).map((_, i) => (
          <MaterialCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div aria-live="polite" className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 py-20 px-6 text-center shadow-sm">
        <h3 className="text-lg font-bold text-red-600 dark:text-red-400 mb-2">Error loading materials</h3>
        <p className="text-gray-500 dark:text-gray-400 mb-4">{error?.message || "Something went wrong."}</p>
      </div>
    );
  }

  if (materials.length === 0) {
    return (
      <div aria-live="polite" className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 py-12 px-6 text-center shadow-sm">
        <h3 className="text-lg font-bold text-gray-900 dark:text-gray-50 mb-3">No materials found</h3>
        <p className="text-gray-600 dark:text-gray-400 mb-6 max-w-md mx-auto">
          {searchQuery
            ? `No results for "${searchQuery}". Try different keywords or browse by subject.`
            : "Try adjusting your filters to find what you're looking for."}
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button
            onClick={onResetFilters}
            className="inline-flex items-center justify-center px-5 py-2.5 bg-blue-600 text-white font-medium text-sm rounded-lg hover:bg-blue-700 transition"
          >
            Clear all filters
          </button>
          <button
            onClick={onBrowseAll}
            className="inline-flex items-center justify-center px-5 py-2.5 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 font-medium text-sm rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition"
          >
            Browse all materials
          </button>
        </div>
        {searchQuery && (
          <div className="mt-8 border-t border-gray-200 dark:border-gray-800 pt-6">
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Try searching for:</p>
            <div className="flex flex-wrap gap-2 justify-center">
              {["Math", "Science", "Technology", "Business"].map((subject) => (
                <button
                  key={subject}
                  onClick={() => onSearchSubject(subject)}
                  className="px-3 py-1.5 bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-300 text-xs font-medium rounded-full hover:bg-blue-100 dark:hover:bg-blue-900/40 transition"
                >
                  {subject}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="flex justify-between items-end mb-4 px-1">
        <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100">
          {activeSubject === "All" ? "All Materials" : `${activeSubject} Materials`}
        </h2>
        <span className="text-sm text-gray-500 dark:text-gray-400">{total || 0} results</span>
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4 }}
        role="list"
        aria-live="polite"
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5"
      >
        {materials.map((material) => {
          const materialId = material._id || material.id;
          const isInCart = cartItems.some((item) => (item._id || item.id) === materialId);
          const isInComparison = comparedItems.some((item) => (item._id || item.id) === materialId);
          return (
            <MaterialCard
              key={materialId}
              material={material}
              isInCart={isInCart}
              isInComparison={isInComparison}
              onAddToCart={onAddToCart}
              onAddToComparison={onAddToComparison}
            />
          );
        })}
      </motion.div>

      {totalPages > 1 && (
        <PaginationBar currentPage={currentPage} totalPages={totalPages} onPageChange={onPageChange} />
      )}
    </>
  );
}
