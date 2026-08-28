"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMarketplaceMaterials } from "@/hooks/api/useMaterials";
import { useCart } from "@/hooks/useCart";
import { useComparison } from "@/hooks/useComparison";
import MarketplaceFilters from "./MarketplaceFilters";
import MarketplaceGrid from "./MarketplaceGrid";
import { MarketplaceFiltersSkeleton } from "./MarketplaceFiltersSkeleton";

const SUBJECTS_CACHE_KEY = "marketplace-subjects";
const SUBJECTS_CACHE_DURATION = 1000 * 60 * 60; // 1 hour

export function MarketplaceContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  
  // Client-side state for filters
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSubject, setActiveSubject] = useState("All");
  const [activeCategory, setActiveCategory] = useState("All");
  const [activeLevel, setActiveLevel] = useState("");
  const [activeLanguage, setActiveLanguage] = useState("");
  const [sortBy, setSortBy] = useState("Popular");
  const [currentPage, setCurrentPage] = useState(1);

  // Subjects and categories state
  const [subjects, setSubjects] = useState([]);
  const [categories, setCategories] = useState([]);
  const [subjectsLoading, setSubjectsLoading] = useState(true);

  // Cart and comparison context
  const { cartItems, addToCart } = useCart();
  const { comparedItems, addToComparison } = useComparison();

  // Initialize state from URL params
  useEffect(() => {
    const urlSearch = searchParams.get("search") || "";
    const urlSubject = searchParams.get("subject") || "All";
    const urlCategory = searchParams.get("category") || "All";
    const urlLevel = searchParams.get("level") || "";
    const urlLanguage = searchParams.get("language") || "";
    const urlSort = searchParams.get("sortBy") || "Popular";
    const urlPage = parseInt(searchParams.get("page") || "1", 10);

    setSearchQuery(urlSearch);
    setActiveSubject(urlSubject);
    setActiveCategory(urlCategory);
    setActiveLevel(urlLevel);
    setActiveLanguage(urlLanguage);
    setSortBy(urlSort);
    setCurrentPage(urlPage);
  }, [searchParams]);

  // Load subjects and categories
  useEffect(() => {
    const loadSubjects = async () => {
      try {
        // Check cache first
        const cached = localStorage.getItem(SUBJECTS_CACHE_KEY);
        if (cached) {
          const { data, timestamp } = JSON.parse(cached);
          if (Date.now() - timestamp < SUBJECTS_CACHE_DURATION) {
            setSubjects(data.subjects || []);
            setCategories(data.categories || []);
            setSubjectsLoading(false);
            return;
          }
        }

        // Fetch fresh data
        const [subjectsRes, categoriesRes] = await Promise.all([
          fetch("/api/subjects"),
          fetch("/api/categories"),
        ]);

        const [subjectsData, categoriesData] = await Promise.all([
          subjectsRes.json(),
          categoriesRes.json(),
        ]);

        const subjectsList = ["All", ...(subjectsData.subjects || [])];
        const categoriesList = categoriesData.categories || [];

        setSubjects(subjectsList);
        setCategories(categoriesList);

        // Cache the results
        localStorage.setItem(
          SUBJECTS_CACHE_KEY,
          JSON.stringify({
            data: { subjects: subjectsList, categories: categoriesList },
            timestamp: Date.now(),
          })
        );
      } catch (error) {
        console.error("Failed to load subjects/categories:", error);
        setSubjects(["All"]);
        setCategories([]);
      } finally {
        setSubjectsLoading(false);
      }
    };

    loadSubjects();
  }, []);

  // Update URL when filters change
  const updateURL = useCallback((newParams) => {
    const params = new URLSearchParams();
    
    // Only add non-default values to prevent unbounded cache entries
    if (newParams.search && newParams.search.trim()) {
      // For search, only cache common/short search terms to prevent unbounded cache
      if (newParams.search.length <= 20 && !/[<>{}[\]\\]/.test(newParams.search)) {
        params.set("search", newParams.search);
      }
    }
    if (newParams.subject && newParams.subject !== "All") {
      params.set("subject", newParams.subject);
    }
    if (newParams.category && newParams.category !== "All") {
      params.set("category", newParams.category);
    }
    if (newParams.level && newParams.level !== "") {
      params.set("level", newParams.level);
    }
    if (newParams.language && newParams.language !== "") {
      params.set("language", newParams.language);
    }
    if (newParams.sortBy && newParams.sortBy !== "Popular") {
      params.set("sortBy", newParams.sortBy);
    }
    if (newParams.page && newParams.page > 1) {
      params.set("page", newParams.page.toString());
    }

    const newURL = params.toString() ? `?${params.toString()}` : "/marketplace";
    router.push(newURL, { scroll: false });
  }, [router]);

  // Build query parameters for API call
  const queryParams = {
    search: searchQuery,
    subject: activeSubject !== "All" ? activeSubject : undefined,
    category: activeCategory !== "All" ? activeCategory : undefined,
    level: activeLevel || undefined,
    language: activeLanguage || undefined,
    sortBy,
    page: currentPage,
    pageSize: 12,
  };

  // Fetch materials
  const {
    data: materialsData,
    isLoading,
    isError,
    error,
  } = useMarketplaceMaterials(queryParams);

  // Filter change handlers
  const handleSearchChange = (search) => {
    setSearchQuery(search);
    setCurrentPage(1);
    updateURL({ ...queryParams, search, page: 1 });
  };

  const handleSubjectChange = (subject) => {
    setActiveSubject(subject);
    setCurrentPage(1);
    updateURL({ ...queryParams, subject, page: 1 });
  };

  const handleCategoryChange = (category) => {
    setActiveCategory(category);
    setCurrentPage(1);
    updateURL({ ...queryParams, category, page: 1 });
  };

  const handleLevelChange = (level) => {
    setActiveLevel(level);
    setCurrentPage(1);
    updateURL({ ...queryParams, level, page: 1 });
  };

  const handleLanguageChange = (language) => {
    setActiveLanguage(language);
    setCurrentPage(1);
    updateURL({ ...queryParams, language, page: 1 });
  };

  const handleSortByChange = (sort) => {
    setSortBy(sort);
    setCurrentPage(1);
    updateURL({ ...queryParams, sortBy: sort, page: 1 });
  };

  const handlePageChange = (page) => {
    setCurrentPage(page);
    updateURL({ ...queryParams, page });
  };

  const handlePageReset = () => {
    setCurrentPage(1);
  };

  // Action handlers
  const handleAddToCart = async (material) => {
    try {
      await addToCart(material);
    } catch (error) {
      console.error("Failed to add to cart:", error);
    }
  };

  const handleAddToComparison = async (material) => {
    try {
      await addToComparison(material);
    } catch (error) {
      console.error("Failed to add to comparison:", error);
    }
  };

  const handleResetFilters = () => {
    setSearchQuery("");
    setActiveSubject("All");
    setActiveCategory("All");
    setActiveLevel("");
    setActiveLanguage("");
    setSortBy("Popular");
    setCurrentPage(1);
    updateURL({
      search: "",
      subject: "All",
      category: "All",
      level: "",
      language: "",
      sortBy: "Popular",
      page: 1,
    });
  };

  const handleBrowseAll = () => {
    handleResetFilters();
  };

  const handleSearchSubject = (subject) => {
    setSearchQuery("");
    setActiveSubject(subject);
    setCurrentPage(1);
    updateURL({ ...queryParams, search: "", subject, page: 1 });
  };

  if (subjectsLoading) {
    return <MarketplaceFiltersSkeleton />;
  }

  const materials = materialsData?.items || [];
  const total = materialsData?.total;
  const totalPages = materialsData?.totalPages || 1;

  return (
    <>
      <MarketplaceFilters
        subjects={subjects}
        categories={categories}
        subjectsLoading={subjectsLoading}
        searchQuery={searchQuery}
        activeSubject={activeSubject}
        activeCategory={activeCategory}
        activeLevel={activeLevel}
        activeLanguage={activeLanguage}
        sortBy={sortBy}
        onSearchChange={handleSearchChange}
        onSubjectChange={handleSubjectChange}
        onCategoryChange={handleCategoryChange}
        onLevelChange={handleLevelChange}
        onLanguageChange={handleLanguageChange}
        onSortByChange={handleSortByChange}
        onPageReset={handlePageReset}
      />

      <main className="flex-1 px-4 md:px-8 py-8 md:py-10">
        {/* Hero Section */}
        <div className="bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-900/30 dark:to-purple-900/30 rounded-2xl p-6 md:p-8 mb-8 text-center">
          <h1 className="text-2xl md:text-3xl font-bold text-gray-900 dark:text-white mb-2">
            Discover Educational Materials
          </h1>
          <p className="text-gray-600 dark:text-gray-300 mb-4 max-w-2xl mx-auto">
            Explore high-quality educational content from creators worldwide. 
            Find the perfect materials for your learning journey.
          </p>
          <div className="flex flex-wrap gap-2 justify-center">
            {subjects.slice(1, 5).map((subject) => (
              <button
                key={subject}
                onClick={() => handleSearchSubject(subject)}
                className="px-4 py-2 bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 text-sm font-medium rounded-full border border-blue-200 dark:border-blue-700 hover:bg-blue-50 dark:hover:bg-blue-900/40 transition-colors"
              >
                {subject}
              </button>
            ))}
          </div>
        </div>

        <MarketplaceGrid
          isLoading={isLoading}
          isError={isError}
          error={error}
          materials={materials}
          total={total}
          activeSubject={activeSubject}
          searchQuery={searchQuery}
          cartItems={cartItems}
          comparedItems={comparedItems}
          onAddToCart={handleAddToCart}
          onAddToComparison={handleAddToComparison}
          onResetFilters={handleResetFilters}
          onBrowseAll={handleBrowseAll}
          onSearchSubject={handleSearchSubject}
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={handlePageChange}
        />
      </main>
    </>
  );
}