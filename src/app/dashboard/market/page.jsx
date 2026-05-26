"use client";

import { useState } from "react";
import { FaFilter } from "react-icons/fa";

const SkeletonCard = () => (
  <div className="bg-white rounded-xl border border-gray-200 p-4 animate-pulse">
    <div className="w-full h-40 bg-gray-200 rounded-lg mb-3" />
    <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
    <div className="h-3 bg-gray-200 rounded w-1/2 mb-2" />
    <div className="h-3 bg-gray-200 rounded w-1/3" />
  </div>
);

export default function MarketPage() {
  const [activeCategory, setActiveCategory] = useState("All");
  const categories = ["All", "Social Sciences", "Engineering", "Pharmacy"];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="mb-6">
        <h1 className="text-xl md:text-2xl font-bold mb-4">
          Legacy marketplace preview
        </h1>
        <p className="text-sm text-gray-600 max-w-2xl">
          This screen is a catalog preview while the Soroban purchase and entitlement flow is being built. No Celo contract calls are made here.
        </p>

        <div className="flex flex-wrap items-center gap-3 mb-6 mt-4">
          {categories.map((category) => (
            <button
              key={category}
              onClick={() => setActiveCategory(category)}
              className={`px-4 py-2 text-sm font-medium rounded-full border transition-all ${
                activeCategory === category
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-white text-gray-700 border-gray-300 hover:bg-gray-100"
              }`}
            >
              {category}
            </button>
          ))}
          <button className="ml-auto flex items-center gap-2 text-gray-700 border border-gray-300 px-4 py-2 rounded-full text-sm hover:bg-gray-100">
            <FaFilter className="text-gray-600" /> Filter
          </button>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}
