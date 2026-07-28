"use client";

import { FaFilter, FaSearch } from "react-icons/fa";

const LEVEL_OPTIONS = [
  { id: "", label: "Any level" },
  { id: "beginner", label: "Beginner" },
  { id: "intermediate", label: "Intermediate" },
  { id: "advanced", label: "Advanced" },
  { id: "all-levels", label: "All Levels" },
];

const SORT_OPTIONS = ["Popular", "Price: Low to High", "Price: High to Low", "Newest", "Top Rated"];

export default function MarketplaceFilters({
  subjects, categories, subjectsLoading,
  searchQuery, activeSubject, activeCategory, activeLevel, sortBy,
  onSearchChange, onSubjectChange, onCategoryChange, onLevelChange, onSortByChange,
  onPageReset,
}) {
  return (
    <>
      {/* Mobile Subjects + Categories */}
      <div className="lg:hidden w-full bg-white dark:bg-surface-strong border-b border-gray-200 dark:border-border-strong">
        <nav aria-label="Subject filters" className="overflow-x-auto px-4 py-3 hide-scrollbar flex gap-2">
          {subjectsLoading ? (
            <div className="px-4 py-1.5 text-sm text-gray-500 dark:text-muted-foreground">Loading subjects...</div>
          ) : (
            subjects.map((subject) => (
              <button
                key={subject}
                onClick={() => { onSubjectChange(subject); onPageReset(); }}
                role="tab"
                aria-selected={activeSubject === subject}
                className={`whitespace-nowrap px-4 py-1.5 rounded-full text-sm transition-all focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  activeSubject === subject
                    ? "bg-blue-600 text-white font-medium shadow-sm"
                    : "bg-gray-100 dark:bg-surface-muted text-gray-600 dark:text-muted-foreground hover:bg-gray-200 dark:hover:bg-surface-strong"
                }`}
              >
                {subject}
              </button>
            ))
          )}
        </nav>
        {categories.length > 0 && (
          <nav aria-label="Category filters" className="overflow-x-auto px-4 pb-3 hide-scrollbar flex gap-2">
            {[{ id: "All", label: "All" }, ...categories].map((cat) => (
              <button
                key={cat.id}
                onClick={() => { onCategoryChange(cat.id); onPageReset(); }}
                role="tab"
                aria-selected={activeCategory === cat.id}
                className={`whitespace-nowrap px-3 py-1 rounded-full text-xs transition-all focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                  activeCategory === cat.id
                    ? "bg-indigo-600 text-white font-medium shadow-sm"
                    : "bg-gray-100 dark:bg-surface-muted text-gray-600 dark:text-muted-foreground hover:bg-gray-200 dark:hover:bg-surface-strong"
                }`}
              >
                {cat.label}
              </button>
            ))}
          </nav>
        )}
      </div>

      {/* Sidebar */}
      <aside className="hidden lg:block w-72 bg-white dark:bg-surface-strong border-r border-gray-200 dark:border-border-strong px-6 py-10 sticky top-0 h-screen overflow-y-auto">
        <nav aria-label="Subject filters">
          <h3 className="text-sm font-bold text-gray-900 dark:text-foreground mb-6 uppercase tracking-wider">Subjects</h3>
          <ul role="list" className="space-y-1">
            {subjectsLoading ? (
              <li role="listitem"><div className="px-3 py-2 text-sm text-gray-500 dark:text-muted-foreground">Loading subjects...</div></li>
            ) : (
              subjects.map((subject) => (
                <li key={subject} role="listitem">
                  <button
                    onClick={() => { onSubjectChange(subject); onPageReset(); }}
                    role="tab"
                    aria-selected={activeSubject === subject}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all focus-visible:ring-2 focus-visible:ring-blue-500 ${
                      activeSubject === subject
                        ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-semibold"
                        : "text-gray-600 dark:text-muted-foreground hover:bg-gray-50 dark:hover:bg-surface-muted hover:text-gray-900 dark:hover:text-foreground"
                    }`}
                  >
                    {subject}
                  </button>
                </li>
              ))
            )}
          </ul>
        </nav>

        {categories.length > 0 && (
          <nav aria-label="Category filters" className="mt-8">
            <h3 className="text-sm font-bold text-gray-900 dark:text-foreground mb-6 uppercase tracking-wider">Categories</h3>
            <ul role="list" className="space-y-1">
              {[{ id: "All", label: "All Categories" }, ...categories].map((cat) => (
                <li key={cat.id} role="listitem">
                  <button
                    onClick={() => { onCategoryChange(cat.id); onPageReset(); }}
                    role="tab"
                    aria-selected={activeCategory === cat.id}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all focus-visible:ring-2 focus-visible:ring-blue-500 ${
                      activeCategory === cat.id
                        ? "bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-semibold"
                        : "text-gray-600 dark:text-muted-foreground hover:bg-gray-50 dark:hover:bg-surface-muted hover:text-gray-900 dark:hover:text-foreground"
                    }`}
                  >
                    {cat.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </aside>

      {/* Filter bar */}
      <div className="bg-white dark:bg-surface-strong p-4 rounded-xl border border-gray-200 dark:border-border-strong shadow-sm mb-8 flex flex-col md:flex-row gap-4 items-center justify-between">
        <div className="relative w-full md:max-w-md">
          <FaSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 dark:text-muted-foreground" />
          <input
            type="text"
            placeholder="Search materials..."
            aria-label="Search materials"
            value={searchQuery}
            onChange={(e) => { onSearchChange(e.target.value); onPageReset(); }}
            className="w-full pl-10 pr-4 py-2 bg-gray-50 dark:bg-surface-muted border border-gray-200 dark:border-border-strong rounded-lg text-sm focus-visible:ring-2 focus-visible:ring-blue-500"
          />
        </div>

        <div className="flex items-center gap-3 overflow-x-auto">
          <div className="flex items-center bg-gray-50 dark:bg-surface-muted border border-gray-200 dark:border-border-strong rounded-lg px-3 py-2">
            <FaFilter className="text-gray-400 dark:text-muted-foreground mr-2 text-xs" />
            <select
              value={activeSubject}
              onChange={(e) => { onSubjectChange(e.target.value); onPageReset(); }}
              aria-label="Filter by subject"
              className="bg-transparent text-sm focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <option value="All">All Subjects</option>
              {subjects.slice(1).map((subject) => (
                <option key={subject} value={subject}>{subject}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center bg-gray-50 dark:bg-surface-muted border border-gray-200 dark:border-border-strong rounded-lg px-3 py-2 hidden md:flex">
            <span className="text-gray-500 dark:text-muted-foreground text-sm mr-2">Level:</span>
            <select
              value={activeLevel}
              onChange={(e) => { onLevelChange(e.target.value); onPageReset(); }}
              aria-label="Filter by level"
              className="bg-transparent text-sm focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              {LEVEL_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center bg-gray-50 dark:bg-surface-muted border border-gray-200 dark:border-border-strong rounded-lg px-3 py-2">
            <span className="text-gray-500 dark:text-muted-foreground text-sm mr-2">Sort:</span>
            <select
              value={sortBy}
              onChange={(e) => onSortByChange(e.target.value)}
              aria-label="Sort materials"
              className="bg-transparent text-sm focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt}>{opt}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </>
  );
}
