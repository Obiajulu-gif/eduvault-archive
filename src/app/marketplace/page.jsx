// Marketplace page: discovery filters are reflected in the URL for shareable searches.
// PERF-AUDIT: See docs/tasks/marketplace-performance-audit.md for full findings.
// Slow components: force-dynamic SSR bypass, eager RecentlyViewedMaterials load,
// per-mount /api/subjects fetch, framer-motion on every card, no Suspense boundaries.

"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FaExchangeAlt,
  FaFilePdf,
  FaFilePowerpoint,
  FaFileWord,
  FaFilter,
  FaHeart,
  FaRegClock,
  FaSearch,
  FaShoppingCart,
  FaStar,
} from "react-icons/fa";
import { motion } from "framer-motion";

import Navbar from "@/components/Navbar";
import ScrollToTop from "@/components/ScrollToTop";
import SaveMaterialButton from "@/components/materials/SaveMaterialButton";
import RecentlyViewedMaterials from "@/components/materials/RecentlyViewedMaterials";
import ResourceStatusBadge from "@/components/materials/ResourceStatusBadge";
import { useMarketplaceMaterials } from "@/hooks/api/useMaterials";
import { useCart } from "@/hooks/useCart";
import { useComparison } from "@/hooks/useComparison";

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

const LEVEL_OPTIONS = [
  { id: "", label: "Any level" },
  { id: "beginner", label: "Beginner" },
  { id: "intermediate", label: "Intermediate" },
  { id: "advanced", label: "Advanced" },
  { id: "all-levels", label: "All Levels" },
];

const CONTENT_TYPE_OPTIONS = [
  { id: "", label: "Any type" },
  { id: "pdf", label: "PDF" },
  { id: "word", label: "Word" },
  { id: "presentation", label: "Presentation" },
  { id: "spreadsheet", label: "Spreadsheet" },
  { id: "text", label: "Text" },
  { id: "zip", label: "ZIP" },
];

const LICENSE_OPTIONS = [
  { id: "", label: "Any license" },
  { id: "standard", label: "Standard License", value: "Standard License (download only)" },
  { id: "creative-commons", label: "Creative Commons", value: "Creative Commons" },
  { id: "private-use", label: "Private Use Only", value: "Private Use Only" },
];

const RATING_OPTIONS = [
  { id: "", label: "Any rating" },
  { id: "4", label: "4+ stars" },
  { id: "3", label: "3+ stars" },
  { id: "2", label: "2+ stars" },
  { id: "1", label: "1+ star" },
];

const NEWEST_OPTIONS = [
  { id: "", label: "Any date" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
];

const SORT_OPTIONS = [
  { id: "newest", label: "Newest first" },
  { id: "popular", label: "Popular" },
  { id: "rating_desc", label: "Highest rated" },
  { id: "price_asc", label: "Price: Low to High" },
  { id: "price_desc", label: "Price: High to Low" },
];

const FALLBACK_IMAGE = "/images/image1.jpg";

function getPreviewImage(material) {
  return material.coverImageUrl || material.thumbnailUrl || material.image || FALLBACK_IMAGE;
}

function MaterialThumbnail({ material }) {
  const [src, setSrc] = useState(() => getPreviewImage(material));
  return (
    <Image
      src={src}
      alt={material.title}
      fill
      className="object-cover group-hover:scale-105 transition-transform duration-500"
      onError={() => setSrc(FALLBACK_IMAGE)}
      sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
    />
  );
}

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

function getAverageScore(material) {
	const score = Number(material.averageScore ?? material.rating);
	return Number.isFinite(score) && score > 0 ? score.toFixed(1) : "New";
}

function getFeedbackCount(material) {
	return Number(material.feedbackCount ?? material.reviewsCount ?? 0) || 0;
}

export default function MarketPage() {
	const { addToCart, cartItems } = useCart();
	const { addToComparison, comparedItems } = useComparison();

	const router = useRouter();

	const [searchQuery, setSearchQuery] = useState("");
	const [activeSubject, setActiveSubject] = useState("all");
	const [activeCategory, setActiveCategory] = useState("All");
	const [activeLevel, setActiveLevel] = useState("");
	const [sortBy, setSortBy] = useState("Popular");

	const [minPrice, setMinPrice] = useState("");
	const [maxPrice, setMaxPrice] = useState("");

	const [creator, setCreator] = useState("");
	const [usageRights, setUsageRights] = useState("");

	const [currentPage, setCurrentPage] = useState(1);

	const [hydrated, setHydrated] = useState(false);

	const [subjects, setSubjects] = useState([ALL_SUBJECT]);
	const [categories, setCategories] = useState([]);
	const [subjectsLoading, setSubjectsLoading] = useState(true);

	const itemsPerPage = 12;

	// Hydrate filters from URL
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);

		setSearchQuery(params.get("search") || "");
		setActiveSubject(params.get("subject") || "all");
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

	// PERF-AUDIT: Measure initial load time using Navigation Timing API.
	// Logs are only emitted in development so they don't reach production.
	useEffect(() => {
		if (typeof window === "undefined" || typeof performance === "undefined") return;
		if (process.env.NODE_ENV !== "development") return;

		const report = () => {
			try {
				const [navEntry] = performance.getEntriesByType("navigation");
				if (navEntry) {
					console.group("[Perf Audit] /marketplace initial load");
					console.log(`TTFB:            ${navEntry.responseStart.toFixed(0)} ms`);
					console.log(`DOM Interactive: ${navEntry.domInteractive.toFixed(0)} ms`);
					console.log(`DOM Complete:    ${navEntry.domComplete.toFixed(0)} ms`);
					console.log(`Load Event End:  ${navEntry.loadEventEnd.toFixed(0)} ms`);
					console.groupEnd();
				}
				// Also report any long tasks if PerformanceObserver is available
				const longTaskEntries = performance.getEntriesByType("longtask");
				if (longTaskEntries.length > 0) {
					console.warn(`[Perf Audit] ${longTaskEntries.length} long task(s) detected on /marketplace:`,
						longTaskEntries.map(e => `${e.name} — ${e.duration.toFixed(0)} ms`));
				}
			} catch {
				// Performance API not fully available in this environment
			}
		};

		// Wait for load event to complete before reading navigation entries
		if (document.readyState === "complete") {
			report();
		} else {
			window.addEventListener("load", report, { once: true });
		}
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
					setSubjects(normalized);
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
		if (activeSubject && activeSubject !== "all") params.set("subject", activeSubject);
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
		hydrated,
		searchQuery,
		activeSubject,
		activeCategory,
		activeLevel,
		sortBy,
		minPrice,
		maxPrice,
		creator,
		usageRights,
		currentPage,
		router,
	]);

	const { data, isLoading, isError, error } =
		useMarketplaceMaterials({
			search: searchQuery,

			subject:
				activeSubject !== "all"
					? activeSubject
					: undefined,

			category:
				activeCategory !== "All"
					? activeCategory
					: undefined,

			level: activeLevel || undefined,

			sortBy:
				sortBy === "Popular"
					? "popular"
					: sortBy === "Price: Low to High"
					? "price_asc"
					: sortBy === "Price: High to Low"
					? "price_desc"
					: sortBy === "Newest"
					? "newest"
					: sortBy === "Top Rated"
					? "top_rated"
					: undefined,

			minPrice: minPrice || undefined,
			maxPrice: maxPrice || undefined,

			creator: creator || undefined,

			usageRights: usageRights || undefined,

			page: currentPage,
			pageSize: itemsPerPage,
		});

	const materials = data?.items || [];
	const totalPages = data?.totalPages || 1;

	const getFileIcon = (type) => {
		switch (type) {
			case "pdf":
				return <FaFilePdf className="text-red-500" />;

			case "doc":
				return <FaFileWord className="text-blue-500" />;

			case "ppt":
				return (
					<FaFilePowerpoint className="text-orange-500" />
				);

			default:
				return <FaFilePdf className="text-gray-500" />;
		}
	};

	const resetFilters = () => {
		setSearchQuery("");
		setActiveSubject("all");
		setActiveCategory("All");
		setActiveLevel("");
		setSortBy("Popular");

		setMinPrice("");
		setMaxPrice("");

		setCreator("");
		setUsageRights("");

		setCurrentPage(1);
	};

	return (
		<>
			<Navbar />

			<section className="flex flex-col lg:flex-row min-h-screen bg-[#fffaf6]">
				{/* Mobile Subjects + Categories */}
				<div className="lg:hidden w-full bg-white border-b border-gray-200">
					<nav aria-label="Subject filters" className="overflow-x-auto px-4 py-3 hide-scrollbar flex gap-2">
						{subjectsLoading ? (
							<div className="px-4 py-1.5 text-sm text-gray-500">
								Loading subjects...
							</div>
						) : (
							subjects.map((subject) => (
								<button
									key={subject.id}
									onClick={() => {
										setActiveSubject(subject.id);
										setCurrentPage(1);
									}}
									role="tab"
									aria-selected={activeSubject === subject.id}
									className={`whitespace-nowrap px-4 py-1.5 rounded-full text-sm transition-all focus-visible:ring-2 focus-visible:ring-blue-500 ${
										activeSubject === subject.id
											? "bg-blue-600 text-white font-medium shadow-sm"
											: "bg-gray-100 text-gray-600 hover:bg-gray-200"
									}`}
								>
									{subject.label}
								</button>
							))
						)}
					</nav>
					{categories.length > 0 && (
						<nav aria-label="Category filters" className="overflow-x-auto px-4 pb-3 hide-scrollbar flex gap-2">
							{[{ id: "All", label: "All" }, ...categories].map((cat) => (
								<button
									key={cat.id}
									onClick={() => {
										setActiveCategory(cat.id);
										setCurrentPage(1);
									}}
									role="tab"
									aria-selected={activeCategory === cat.id}
									className={`whitespace-nowrap px-3 py-1 rounded-full text-xs transition-all focus-visible:ring-2 focus-visible:ring-indigo-500 ${
										activeCategory === cat.id
											? "bg-indigo-600 text-white font-medium shadow-sm"
											: "bg-gray-100 text-gray-600 hover:bg-gray-200"
									}`}
								>
									{cat.label}
								</button>
							))}
						</nav>
					)}
				</div>

				{/* Sidebar */}
				<aside className="hidden lg:block w-72 bg-white border-r border-gray-200 px-6 py-10 sticky top-0 h-screen overflow-y-auto">
					<nav aria-label="Subject filters">
					<h3 className="text-sm font-bold text-gray-900 mb-6 uppercase tracking-wider">
						Subjects
					</h3>

					<ul role="list" className="space-y-1">
						{subjectsLoading ? (
							<li role="listitem">
								<div className="px-3 py-2 text-sm text-gray-500">
									Loading subjects...
								</div>
							</li>
						) : (
							subjects.map((subject) => (
								<li key={subject.id} role="listitem">
									<button
										onClick={() => {
											setActiveSubject(subject.id);
											setCurrentPage(1);
										}}
										role="tab"
										aria-selected={activeSubject === subject.id}
										className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all focus-visible:ring-2 focus-visible:ring-blue-500 ${
											activeSubject === subject.id
												? "bg-blue-50 text-blue-700 font-semibold"
												: "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
										}`}
									>
										{subject.label}
									</button>
								</li>
							))
						)}
					</ul>
					</nav>

					{categories.length > 0 && (
						<nav aria-label="Category filters" className="mt-8">
							<h3 className="text-sm font-bold text-gray-900 mb-6 uppercase tracking-wider">
								Categories
							</h3>
							<ul role="list" className="space-y-1">
								{[{ id: "All", label: "All Categories" }, ...categories].map((cat) => (
									<li key={cat.id} role="listitem">
										<button
											onClick={() => {
												setActiveCategory(cat.id);
												setCurrentPage(1);
											}}
											role="tab"
											aria-selected={activeCategory === cat.id}
											className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all focus-visible:ring-2 focus-visible:ring-blue-500 ${
												activeCategory === cat.id
													? "bg-indigo-50 text-indigo-700 font-semibold"
													: "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
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

				{/* Main */}
				<main className="flex-1 px-4 md:px-8 py-8 md:py-10 overflow-x-hidden">
					{/* Hero */}
					<motion.div
						initial={{ opacity: 0, y: 10 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.4 }}
						className="bg-linear-to-r from-blue-50 to-indigo-50 border border-blue-100 rounded-2xl p-6 mb-8"
					>
						<h1 className="text-xl md:text-2xl font-bold text-gray-900 mb-2">
							Academic Marketplace
						</h1>

						<p className="text-gray-600 text-sm mb-4">
							Search by title, description,
							and author.
						</p>

							<button className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-all shadow-sm focus-visible:ring-2 focus-visible:ring-blue-500">
								Share Your Notes
							</button>
					</motion.div>

					{/* Recently Viewed */}
					<RecentlyViewedMaterials />

					{/* Filters */}
					<div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm mb-8 flex flex-col md:flex-row gap-4 items-center justify-between">
						<div className="relative w-full md:max-w-md">
							<FaSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />

								<input
									type="text"
									placeholder="Search materials..."
									aria-label="Search materials"
									value={searchQuery}
								onChange={(e) => {
									setSearchQuery(e.target.value);
									setCurrentPage(1);
								}}
								className="w-full pl-10 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus-visible:ring-2 focus-visible:ring-blue-500"
							/>
						</div>

						<div className="flex items-center gap-3 overflow-x-auto">
							<div className="flex items-center bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
								<FaFilter className="text-gray-400 mr-2 text-xs" />

										<select
											value={activeSubject}
											onChange={(e) => {
												setActiveSubject(
													e.target.value
												);

												setCurrentPage(1);
											}}
											aria-label="Filter by subject"
											className="bg-transparent text-sm focus-visible:ring-2 focus-visible:ring-blue-500"
								>
									<option value="All">
										All Subjects
									</option>

									{subjects.slice(1).map(
										(subject) => (
											<option
												key={subject}
												value={subject}
											>
												{subject}
											</option>
										)
									)}
								</select>
							</div>

							<div className="flex items-center bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 hidden md:flex">
								<span className="text-gray-500 text-sm mr-2">
									Level:
								</span>

										<select
											value={activeLevel}
											onChange={(e) => {
												setActiveLevel(
													e.target.value
												);

												setCurrentPage(1);
											}}
											aria-label="Filter by level"
											className="bg-transparent text-sm focus-visible:ring-2 focus-visible:ring-blue-500"
								>
									{LEVEL_OPTIONS.map((opt) => (
										<option key={opt.id} value={opt.id}>{opt.label}</option>
									))}
								</select>
							</div>

							<div className="flex items-center bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
								<span className="text-gray-500 text-sm mr-2">
									Sort:
								</span>

										<select
											value={sortBy}
											onChange={(e) =>
												setSortBy(
													e.target.value
												)
											}
											aria-label="Sort materials"
											className="bg-transparent text-sm focus-visible:ring-2 focus-visible:ring-blue-500"
								>
									<option>Popular</option>
									<option>
										Price: Low to High
									</option>
									<option>
										Price: High to Low
									</option>
									<option>Newest</option>
									<option>Top Rated</option>
								</select>
							</div>
						</div>
					</div>

					{/* Loading */}
					{isLoading ? (
						<div aria-live="polite" aria-busy="true" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
							{Array.from({
								length: itemsPerPage,
							}).map((_, i) => (
								<div
									key={i}
									className="bg-white rounded-xl border border-gray-200 p-5 animate-pulse h-56"
								/>
							))}
						</div>
					) : isError ? (
						<div aria-live="polite" className="bg-white rounded-2xl border border-gray-200 py-20 px-6 text-center shadow-sm">
							<h3 className="text-lg font-bold text-red-600 mb-2">
								Error loading materials
							</h3>

							<p className="text-gray-500 mb-4">
								{error?.message ||
									"Something went wrong."}
							</p>
						</div>
					) : materials.length === 0 ? (
						<div aria-live="polite" className="bg-white rounded-2xl border border-gray-200 py-12 px-6 text-center shadow-sm">
							<h3 className="text-lg font-bold text-gray-900 mb-3">
								No materials found
							</h3>
							<p className="text-gray-600 mb-6 max-w-md mx-auto">
								{searchQuery
									? `No results for "${searchQuery}". Try different keywords or browse by subject.`
									: "Try adjusting your filters to find what you're looking for."}
							</p>
							<div className="flex flex-col sm:flex-row gap-3 justify-center">
								<button
									onClick={resetFilters}
									className="inline-flex items-center justify-center px-5 py-2.5 bg-blue-600 text-white font-medium text-sm rounded-lg hover:bg-blue-700 transition"
								>
									Clear all filters
								</button>
								<button
									onClick={() => {
										setSearchQuery("");
										setCurrentPage(1);
									}}
									className="inline-flex items-center justify-center px-5 py-2.5 border border-gray-200 text-gray-700 font-medium text-sm rounded-lg hover:bg-gray-50 transition"
								>
									Browse all materials
								</button>
							</div>
							{searchQuery && (
								<div className="mt-8 border-t border-gray-200 pt-6">
									<p className="text-sm text-gray-500 mb-4">Try searching for:</p>
									<div className="flex flex-wrap gap-2 justify-center">
										{["Math", "Science", "Technology", "Business"].map((subject) => (
											<button
												key={subject}
												onClick={() => {
													setSearchQuery(subject.toLowerCase());
													setActiveSubject(subject);
													setCurrentPage(1);
												}}
												className="px-3 py-1.5 bg-blue-50 text-blue-600 text-xs font-medium rounded-full hover:bg-blue-100 transition"
											>
												{subject}
											</button>
										))}
									</div>
								</div>
							)}
						</div>
					) : (
						<>
							<div className="flex justify-between items-end mb-4 px-1">
								<h2 className="text-lg font-bold text-gray-800">
									{activeSubject === "All"
										? "All Materials"
										: `${activeSubject} Materials`}
								</h2>

								<span className="text-sm text-gray-500">
									{data?.total || 0} results
								</span>
							</div>

							<motion.div
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								transition={{
									duration: 0.4,
								}}
								role="list"
								aria-live="polite"
								className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5"
							>
								{materials.map((material) => {
									const materialId =
										material._id ||
										material.id;

									const isAlreadyInCart =
										cartItems.some(
											(item) =>
												(item._id ||
													item.id) ===
												materialId
										);

									const isAlreadyInComp =
										comparedItems.some(
											(item) =>
												(item._id ||
													item.id) ===
												materialId
										);

									const creatorAddress =
										material.userAddress ||
										material.ownerAddress ||
										"default";

									return (
										<article
											key={materialId}
											role="listitem"
											className="relative bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm hover:shadow-md hover:border-blue-300 transition-all duration-300 flex flex-col group"
										>
											<SaveMaterialButton
												material={
													material
												}
											/>

											<Link
												href={`/marketplace/${materialId}`}
												className="relative w-full h-36 bg-gray-100 overflow-hidden block"
											>
												<MaterialThumbnail material={material} />
												{material.subject && (
													<span className="absolute top-2 left-2 bg-white/90 backdrop-blur-sm text-gray-700 font-semibold text-[10px] px-2 py-0.5 rounded-md border border-gray-200 shadow-sm">
														{material.subject}
													</span>
												)}
												{material.level && (
													<span className="absolute top-2 right-2 bg-white/90 backdrop-blur-sm text-blue-700 font-semibold text-[10px] px-2 py-0.5 rounded-md border border-blue-200 shadow-sm">
														{LEVEL_OPTIONS.find(l => l.id === material.level)?.label || material.level}
													</span>
												)}
											</Link>

											<div className="p-4 flex-1 flex flex-col gap-2">
												<Link
													href={`/marketplace/${materialId}`}
												>
													<h3 className="text-sm font-bold text-gray-900 line-clamp-2 leading-snug hover:text-blue-600 transition-colors">
														{
															material.title
														}
													</h3>
												</Link>

												<p className="text-xs text-gray-500">
													by{" "}
													<Link
														href={`/creator/${creatorAddress}`}
														className="font-semibold text-blue-600 hover:underline"
													>
														{material.author ||
															"Anonymous"}
													</Link>
												</p>

												<ResourceStatusBadge material={material} max={3} />

												<p className="text-xs text-gray-400 line-clamp-2 leading-relaxed">
													{material.shortSummary ||
														material.description ||
														"No description"}
												</p>

												<div className="mt-auto pt-3 border-t border-gray-100 space-y-3">
													<div className="flex justify-between items-center">
														<div className="flex items-center gap-1">
															<FaStar className="text-yellow-400 w-3.5 h-3.5" />
															<span className="text-xs font-semibold text-gray-700">
																{getAverageScore(material)}
															</span>
															<span className="text-[11px] text-gray-400">
																({getFeedbackCount(material)})
															</span>
														</div>

														<div className="bg-blue-50 text-blue-700 px-2.5 py-1 rounded-lg text-sm font-bold border border-blue-100">
															{material.price}
															<span className="text-[10px] font-medium text-blue-500 ml-1">
																XLM
															</span>
														</div>
													</div>

													<div className="flex items-center justify-between text-[11px] text-gray-400">
														<div className="flex items-center gap-3">
															<span className="flex items-center gap-1">
																{getFileIcon(material.fileType)}
																<span className="uppercase font-medium">
																	{material.fileType || "pdf"}
																</span>
															</span>
															<span className="flex items-center gap-1">
																<FaHeart className="w-3 h-3" />
																{material.likes || 0}
															</span>
															{material.pages && (
																<span className="flex items-center gap-1">
																	<FaRegClock className="w-3 h-3" />
																	{material.pages} pgs
																</span>
															)}
														</div>
													</div>

													<div className="grid grid-cols-2 gap-2">
														<button
															onClick={() =>
																addToComparison(
																	material
																)
															}
															className={`flex items-center justify-center gap-1 py-2 rounded-lg font-bold text-[11px] border transition-all focus-visible:ring-2 focus-visible:ring-blue-500 ${
																isAlreadyInComp
																	? "bg-amber-500 border-amber-600 text-white"
																	: "bg-white border-gray-200 text-gray-600 hover:bg-gray-50"
															}`}
														>
															<FaExchangeAlt className="w-3 h-3" />
															{isAlreadyInComp
																? "Contrasted"
																: "Contrast"}
														</button>

														<button
															onClick={() =>
																addToCart(
																	material
																)
															}
															className={`flex items-center justify-center gap-1 py-2 rounded-lg font-bold text-[11px] border transition-all focus-visible:ring-2 focus-visible:ring-blue-500 ${
																isAlreadyInCart
																	? "bg-emerald-600 border-emerald-700 text-white"
																	: "bg-blue-600 hover:bg-blue-700 border-blue-700 text-white"
															}`}
														>
															<FaShoppingCart className="w-3 h-3" />
															{isAlreadyInCart
																? "In Cart"
																: "Add to Cart"}
														</button>
													</div>
												</div>
											</div>
										</article>
									);
								})}
							</motion.div>

							{/* Pagination */}
							{totalPages > 1 && (
								<nav aria-label="Pagination">
								<div className="flex justify-center mt-8 gap-2">
									{Array.from({
										length: totalPages,
									}).map((_, i) => (
										<button
											key={i}
											onClick={() =>
												setCurrentPage(
													i + 1
												)
											}
											aria-current={currentPage === i + 1 ? "page" : undefined}
											className={`px-3 py-1.5 rounded focus-visible:ring-2 focus-visible:ring-blue-500 ${
												currentPage ===
												i + 1
													? "bg-blue-600 text-white"
													: "bg-gray-100 text-gray-700 hover:bg-gray-200"
											}`}
										>
											{i + 1}
										</button>
									))}
								</div>
								</nav>
							)}
						</>
					)}
				</main>
			</section>

			<ScrollToTop />
		</>
	);
}
