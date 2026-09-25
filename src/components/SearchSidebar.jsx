"use client";

import { useState } from "react";
import { FaChevronDown, FaTimes } from "react-icons/fa";

export default function SearchSidebar({
  subjects = [],
  onFilterChange,
  mobileOpen,
  onMobileClose,
}) {
  const [categories, setCategories] = useState({});
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");

  const handleCategoryToggle = (category) => {
    const updated = {
      ...categories,
      [category]: !categories[category],
    };
    setCategories(updated);
    onFilterChange?.({
      categories: Object.keys(updated).filter((k) => updated[k]),
      minPrice,
      maxPrice,
    });
  };

  const handlePriceChange = (min, max) => {
    setMinPrice(min);
    setMaxPrice(max);
    onFilterChange?.({
      categories: Object.keys(categories).filter((k) => categories[k]),
      minPrice: min,
      maxPrice: max,
    });
  };

  const content = (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Categories</h3>
        <div className="space-y-2">
          {subjects.map((subject) => (
            <label key={subject} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={categories[subject] || false}
                onChange={() => handleCategoryToggle(subject)}
                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">{subject}</span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Price Range (XLM)</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-600 mb-1">Min Price</label>
            <input
              type="number"
              min="0"
              value={minPrice}
              onChange={(e) => handlePriceChange(e.target.value, maxPrice)}
              placeholder="0"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Max Price</label>
            <input
              type="number"
              min="0"
              value={maxPrice}
              onChange={(e) => handlePriceChange(minPrice, e.target.value)}
              placeholder="No limit"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden md:block w-56 bg-white border-r border-gray-200 p-6 h-screen sticky top-0 overflow-y-auto">
        {content}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="fixed inset-0 bg-black/50" onClick={onMobileClose} />
          <div className="fixed right-0 top-0 bottom-0 w-64 bg-white shadow-xl">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h2 className="font-semibold text-gray-900">Filters</h2>
              <button
                onClick={onMobileClose}
                className="text-gray-400 hover:text-gray-600"
              >
                <FaTimes />
              </button>
            </div>
            <div className="p-6">{content}</div>
          </div>
        </div>
      )}
    </>
  );
}
