"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";

import Navbar from "@/components/Navbar";
import ScrollToTop from "@/components/ScrollToTop";
import RecentlyViewedMaterials from "@/components/materials/RecentlyViewedMaterials";
import { useMarketplaceMaterials } from "@/hooks/api/useMaterials";
import { useCart } from "@/hooks/useCart";
import { useComparison } from "@/hooks/useComparison";

import { MarketplaceFilters, MarketplaceGrid } from "@/components/marketplace";

export const dynamic = "force-dynamic";

const ALL_SUBJECT = { id: "all", label: "All" };

const DEFAULT_SUBJECTS = [
  ALL_SUBJECT,
  { id: "mathematics", label: "Math" },
  { id: "science", label: "Science" },
  { id: "law", label: "Law" },
  { id: "technology", label: "Technology" },
  { id: "business", label: "Business" },
  { id: "medicine", label: "Medicine" },
  { id: "arts", label: "Arts" },
];

const SORT_MAP = {
  Popular: "popular",
  "Price: Low to High": "price_asc",
  "Price: High to Low": "price_desc",
  Newest: "newest",
  "Top Rated": "top_rated",
};

function normalizeSubjectOptions(subjects) {
  if (!Array.isArray(subjects) || subjects.length === 0) return DEFAULT_SUBJECTS;

  const seen = new Set(["all"]);
  const normalized = subjects
    .map((subject) => {
      if (typeof subject === "string") {
        return subject.toLowerCase() === "all" ? ALL_SUBJECT : { id: subject, label: subject };
      }
      return {
        id: subject?.id || subject?.label,
        label: subject?.label || subject?.id,
      };
    })
    .filter((subject) => subject.id && subject.label)
    .filter((subject) => {
      const key = subject.id.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return [ALL_SUBJECT, ...normalized];
}

export default function MarketPage() {
  const { addToCart, cartItems } = useCart();
  const { addToComparison, comparedItems } = useComparison();

  const router = useRouter();

  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [activeSubject, setActiveSubject] = useState("All");
  const [activeCategory, setActiveCategory] = useState("All");
  const [activeLevel, setActiveLevel] = useState("");
  const [sortBy, setSortBy] = useState("Popular");

  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");

  const [creator, setCreator] = useState("");
  const [usageRights, setUsageRights] = useState("");

  const [currentPage, setCurrentPage] = useState(1);

  const [hydrated, setHydrated] = useState(false);

  const [subjects, setSubjects] = useState(["All"]);
  const [categories, setCategories] = useState([]);
  const [subjectsLoading, setSubjectsLoading] = useState(true);

  const itemsPerPage = 12;

  // Hydrate filters from URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    const initialSearch = params.get("search") || "";
    setSearchQuery(initialSearch);
    setDebouncedSearchQuery(initialSearch);
    setActiveSubject(params.get("subject") || "All");
    setActiveCategory(params.get("category") || "All");
    setActiveLevel(params.get("level") || "");
    setSortBy(params.get("sortBy") || "Popular");

    setMinPrice(params.get("minPrice") || "");
    setMaxPrice(params.get("maxPrice") || "");

    setCreator(params.get("creator") || "");
    setUsageRights(params.get("usageRights") || "");

    setCurrentPage(Number(params.get("page") || 1));

    setHydrated(true);
  }, []);

  // Load subjects
  useEffect(() => {
    async function loadSubjects() {
      try {
        setSubjectsLoading(true);

        const res = await fetch("/api/subjects");

        if (res.ok) {
          const data = await res.json();
          const normalized = normalizeSubjectOptions(data.subjects || data);
          setSubjects(normalized.map((s) => s.label || s.id || String(s)));
          setCategories(data.categories || []);
        }
      } catch {
        // keep default subjects on error
      } finally {
        setSubjectsLoading(false);
      }
    }

    loadSubjects();
  }, []);

  // Sync filter state to URL for shareable links
  useEffect(() => {
    if (!hydrated) return;

    const params = new URLSearchParams();

    if (searchQuery) params.set("search", searchQuery);
    if (activeSubject && activeSubject !== "All") params.set("subject", activeSubject);
    if (activeCategory !== "All") params.set("category", activeCategory);
    if (activeLevel) params.set("level", activeLevel);
    if (sortBy && sortBy !== "Popular") params.set("sortBy", sortBy);
    if (minPrice) params.set("minPrice", minPrice);
    if (maxPrice) params.set("maxPrice", maxPrice);
    if (creator) params.set("creator", creator);
    if (usageRights) params.set("usageRights", usageRights);

    if (currentPage > 1) {
      params.set("page", String(currentPage));
    }

    router.replace(`/marketplace?${params.toString()}`);
  }, [
    hydrated, searchQuery, activeSubject, activeCategory, activeLevel,
    sortBy, minPrice, maxPrice, creator, usageRights, currentPage, router,
  ]);

  // Debounce the search query so we don't hit the API on every keystroke
  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);
    return () => clearTimeout(timeout);
  }, [searchQuery]);

  const { data, isLoading, isError, error } =
    useMarketplaceMaterials({
      search: debouncedSearchQuery,
      subject: activeSubject !== "All" ? activeSubject : undefined,
      category: activeCategory !== "All" ? activeCategory : undefined,
      level: activeLevel || undefined,
      sortBy: SORT_MAP[sortBy],
      minPrice: minPrice || undefined,
      maxPrice: maxPrice || undefined,
      creator: creator || undefined,
      usageRights: usageRights || undefined,
      page: currentPage,
      pageSize: itemsPerPage,
    });

  const materials = data?.items || [];
  const totalPages = data?.totalPages || 1;

  const handleSearchChange = (value) => {
    setSearchQuery(value);
  };

  const handleSubjectChange = (subject) => {
    setActiveSubject(subject);
  };

  const handleCategoryChange = (category) => {
    setActiveCategory(category);
  };

  const handleLevelChange = (level) => {
    setActiveLevel(level);
  };

  const handleSortByChange = (value) => {
    setSortBy(value);
  };

  const handlePageReset = () => {
    setCurrentPage(1);
  };

  const handlePageChange = (page) => {
    setCurrentPage(page);
  };

  const resetFilters = () => {
    setSearchQuery("");
    setDebouncedSearchQuery("");
    setActiveSubject("All");
    setActiveCategory("All");
    setActiveLevel("");
    setSortBy("Popular");
    setMinPrice("");
    setMaxPrice("");
    setCreator("");
    setUsageRights("");
    setCurrentPage(1);
  };

  const handleBrowseAll = () => {
    setSearchQuery("");
    setDebouncedSearchQuery("");
    setCurrentPage(1);
  };

  const handleSearchSubject = (subject) => {
    setSearchQuery(subject.toLowerCase());
    setDebouncedSearchQuery(subject.toLowerCase());
    setActiveSubject(subject);
    setCurrentPage(1);
  };

  return (
    <>
      <Navbar />

      <section className="flex flex-col lg:flex-row min-h-screen bg-background">
        <MarketplaceFilters
          subjects={subjects}
          categories={categories}
          subjectsLoading={subjectsLoading}
          searchQuery={searchQuery}
          activeSubject={activeSubject}
          activeCategory={activeCategory}
          activeLevel={activeLevel}
          sortBy={sortBy}
          onSearchChange={handleSearchChange}
          onSubjectChange={handleSubjectChange}
          onCategoryChange={handleCategoryChange}
          onLevelChange={handleLevelChange}
          onSortByChange={handleSortByChange}
          onPageReset={handlePageReset}
        />

        <main className="flex-1 px-4 md:px-8 py-8 md:py-10 overflow-x-hidden">
          {/* Hero */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="bg-linear-to-r from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 border border-blue-100 dark:border-blue-900/50 rounded-2xl p-6 mb-8"
          >
            <h1 className="text-xl md:text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
              Academic Marketplace
            </h1>

            <p className="text-gray-600 dark:text-gray-400 text-sm mb-4">
              Search by title, description, and author.
            </p>

            <button className="bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-all shadow-sm focus-visible:ring-2 focus-visible:ring-blue-500">
              Share Your Notes
            </button>
          </motion.div>

          {/* Recently Viewed */}
          <RecentlyViewedMaterials />

          {/* Results grid with loading/error/empty states */}
          <MarketplaceGrid
            isLoading={isLoading}
            isError={isError}
            error={error}
            materials={materials}
            total={data?.total || 0}
            activeSubject={activeSubject}
            searchQuery={searchQuery}
            cartItems={cartItems}
            comparedItems={comparedItems}
            onAddToCart={addToCart}
            onAddToComparison={addToComparison}
            onResetFilters={resetFilters}
            onBrowseAll={handleBrowseAll}
            onSearchSubject={handleSearchSubject}
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={handlePageChange}
          />
        </main>
      </section>

      <ScrollToTop />
    </>
  );
}
