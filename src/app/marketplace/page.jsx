// Marketplace page: supports search, filters, sorting, pagination, and empty/loading/error states. State is reflected in the URL for shareability.

"use client";

import { Suspense, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { FaHeart, FaSearch, FaFilter, FaStar, FaFilePdf, FaFileWord, FaFilePowerpoint, FaRegClock } from "react-icons/fa";
import { motion } from "framer-motion";
import Navbar from "@/components/Navbar";
import { useRouter, useSearchParams } from "next/navigation";
import { useMarketplaceMaterials } from "@/hooks/api/useMaterials";

const SUBJECTS = ["Math", "Science", "Law", "Technology", "Business", "Medicine", "Arts"];

function MarketPageContent() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const [searchQuery, setSearchQuery] = useState(searchParams.get("search") || "");
	const [activeSubject, setActiveSubject] = useState(searchParams.get("subject") || "All");
	const [sortBy, setSortBy] = useState(searchParams.get("sortBy") || "Popular");
	const [minPrice, setMinPrice] = useState(searchParams.get("minPrice") || "");
	const [maxPrice, setMaxPrice] = useState(searchParams.get("maxPrice") || "");
	const [creator, setCreator] = useState(searchParams.get("creator") || "");
	const [usageRights, setUsageRights] = useState(searchParams.get("usageRights") || "");
	const [currentPage, setCurrentPage] = useState(Number(searchParams.get("page") || 1));
	const itemsPerPage = 12;

	// Sync state to URL
	useEffect(() => {
		const params = new URLSearchParams();
		if (searchQuery) params.set("search", searchQuery);
		if (activeSubject && activeSubject !== "All") params.set("subject", activeSubject);
		if (sortBy && sortBy !== "Popular") params.set("sortBy", sortBy);
		if (minPrice) params.set("minPrice", minPrice);
		if (maxPrice) params.set("maxPrice", maxPrice);
		if (creator) params.set("creator", creator);
		if (usageRights) params.set("usageRights", usageRights);
		if (currentPage > 1) params.set("page", currentPage);
		router.replace(`/marketplace?${params.toString()}`);
	}, [router, searchQuery, activeSubject, sortBy, minPrice, maxPrice, creator, usageRights, currentPage]);

	const { data, isLoading, isError, error } = useMarketplaceMaterials({
		search: searchQuery,
		subject: activeSubject !== "All" ? activeSubject : undefined,
		sortBy: sortBy === "Popular" ? "popular" : sortBy === "Price: Low to High" ? "price_asc" : sortBy === "Price: High to Low" ? "price_desc" : undefined,
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
		switch(type) {
			case 'pdf': return <FaFilePdf className="text-red-500" />;
			case 'doc': return <FaFileWord className="text-blue-500" />;
			case 'ppt': return <FaFilePowerpoint className="text-orange-500" />;
			default: return <FaFilePdf className="text-gray-500" />;
		}
	};

	const resetFilters = () => {
		setSearchQuery("");
		setActiveSubject("All");
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

			<div className="absolute inset-0 bg-[linear-gradient(to_right,#f2ede8_1px,transparent_1px),linear-gradient(to_bottom,#f2ede8_1px,transparent_1px)] bg-size-[40px_40px] opacity-70 pointer-events-none -z-1" aria-hidden="true"></div>

			<section className="flex flex-col lg:flex-row min-h-screen bg-[#fffaf6] relative z-0">
				<div className="lg:hidden w-full overflow-x-auto bg-white border-b border-gray-200 px-4 py-3 hide-scrollbar flex gap-2">
					{["All", ...SUBJECTS].map((subject) => (
						<button
							key={subject}
							onClick={() => {
								setActiveSubject(subject);
								setCurrentPage(1);
							}}
							className={`whitespace-nowrap px-4 py-1.5 rounded-full text-sm transition-all ${activeSubject === subject ? "bg-blue-600 text-white font-medium shadow-sm" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
						>
							{subject}
						</button>
					))}
				</div>

				<aside className="hidden lg:block w-72 bg-white border-r border-gray-200 px-6 py-10 sticky top-0 h-screen overflow-y-auto">
					<h3 className="text-sm font-bold text-gray-900 mb-6 uppercase tracking-wider">Subjects</h3>
					<ul className="space-y-1">
						{["All", ...SUBJECTS].map((subject) => (
							<li key={subject}>
								<button
									onClick={() => {
										setActiveSubject(subject);
										setCurrentPage(1);
									}}
									className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all ${activeSubject === subject ? "bg-blue-50 text-blue-700 font-semibold" : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"}`}
								>
									{subject}
								</button>
							</li>
						))}
					</ul>
				</aside>

				<main className="flex-1 px-4 md:px-8 py-8 md:py-10 overflow-x-hidden">
					<motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="bg-linear-to-r from-blue-50 to-indigo-50 border border-blue-100 rounded-2xl p-6 mb-8 flex flex-col md:flex-row justify-between items-center relative overflow-hidden">
						<div className="relative z-10 w-full md:w-2/3">
							<h1 className="text-xl md:text-2xl font-bold text-gray-900 mb-2">Academic Marketplace</h1>
							<p className="text-gray-600 text-sm mb-4">Search by title, description, and author. Then narrow results by subject and price sorting.</p>
							<button
								type="button"
								aria-label="Share your notes"
								className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-all shadow-sm"
							>
								Share Your Notes
							</button>
						</div>
					</motion.div>

					<div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm mb-8 flex flex-col md:flex-row gap-4 items-center justify-between relative z-10">
						<div className="relative w-full md:max-w-md">
							<FaSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
							<input
								type="text"
								placeholder="Search title, description, or author..."
								value={searchQuery}
								onChange={(e) => {
									setSearchQuery(e.target.value);
									setCurrentPage(1);
								}}
								className="w-full pl-10 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all"
							/>
						</div>

						<div className="flex w-full md:w-auto items-center gap-3 overflow-x-auto hide-scrollbar">
							<div className="flex items-center bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 shrink-0">
								<FaFilter className="text-gray-400 mr-2 text-xs" />
								<select
									value={activeSubject}
									onChange={(e) => {
										setActiveSubject(e.target.value);
										setCurrentPage(1);
									}}
									className="bg-transparent text-sm text-gray-700 focus:outline-none cursor-pointer"
								>
									<option value="All">All Subjects</option>
									{SUBJECTS.map((subject) => (
										<option key={subject} value={subject}>{subject}</option>
									))}
								</select>
							</div>

							{/* Price Range Filter */}
							<div className="flex items-center bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 shrink-0 gap-2">
								<span className="text-gray-500 text-xs">Price:</span>
								<input type="number" min="0" placeholder="Min" value={minPrice} onChange={e => setMinPrice(e.target.value)} className="w-14 px-1 py-0.5 rounded border border-gray-200 text-xs" />
								<span className="text-gray-400">-</span>
								<input type="number" min="0" placeholder="Max" value={maxPrice} onChange={e => setMaxPrice(e.target.value)} className="w-14 px-1 py-0.5 rounded border border-gray-200 text-xs" />
							</div>

							{/* Creator Filter */}
							<div className="flex items-center bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 shrink-0 gap-2">
								<span className="text-gray-500 text-xs">Creator:</span>
								<input type="text" placeholder="Name" value={creator} onChange={e => setCreator(e.target.value)} className="w-20 px-1 py-0.5 rounded border border-gray-200 text-xs" />
							</div>

							{/* Usage Rights Filter */}
							<div className="flex items-center bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 shrink-0 gap-2">
								<span className="text-gray-500 text-xs">Rights:</span>
								<input type="text" placeholder="e.g. CC-BY" value={usageRights} onChange={e => setUsageRights(e.target.value)} className="w-20 px-1 py-0.5 rounded border border-gray-200 text-xs" />
							</div>

							<div className="flex items-center bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 shrink-0">
								<span className="text-gray-500 text-sm mr-2">Sort:</span>
								<select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="bg-transparent text-sm font-medium text-gray-800 focus:outline-none cursor-pointer">
									<option>Popular</option>
									<option>Highest Rated</option>
									<option>Price: Low to High</option>
									<option>Price: High to Low</option>
								</select>
							</div>
						</div>
					</div>

					{isLoading ? (
						<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
							{Array.from({ length: itemsPerPage }).map((_, i) => (
								<div key={i} className="bg-white rounded-xl border border-gray-200 p-5 animate-pulse h-56" />
							))}
						</div>
					) : isError ? (
						<div className="bg-white rounded-2xl border border-gray-200 py-20 px-6 text-center shadow-sm">
							<h3 className="text-lg font-bold text-red-600 mb-2">Error loading materials</h3>
							<p className="text-gray-500 mb-4">{error?.message || "Something went wrong."}</p>
							<button onClick={() => window.location.reload()} className="text-blue-600 font-medium text-sm hover:underline">Retry</button>
						</div>
					) : materials.length === 0 ? (
						<div className="bg-white rounded-2xl border border-gray-200 py-20 px-6 text-center shadow-sm">
							<div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4"><FaSearch className="text-gray-400 text-2xl" /></div>
							<h3 className="text-lg font-bold text-gray-900 mb-2">No materials found</h3>
							<button onClick={resetFilters} className="text-blue-600 font-medium text-sm hover:underline">Clear all filters</button>
						</div>
					) : (
						<>
							<div className="flex justify-between items-end mb-4 px-1">
								<h2 className="text-lg font-bold text-gray-800">{activeSubject === "All" ? "All Materials" : `${activeSubject} Materials`}</h2>
								<span className="text-sm text-gray-500">{data?.total || 0} results</span>
							</div>
							<motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5 relative z-10">
								{materials.map((material) => (
									<Link href={`/marketplace/${material._id || material.id}`} key={material._id || material.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm hover:shadow-md hover:border-blue-300 transition-all duration-300 flex flex-col group">
										<div className="relative w-full h-28 bg-gray-100 overflow-hidden">
											<Image src={material.image || material.thumbnailUrl || "/images/image1.jpg"} alt={material.title} fill className="object-cover group-hover:scale-105 transition-transform duration-500" />
										</div>
										<div className="p-4 flex-1 flex flex-col">
											<h3 className="text-sm font-bold text-gray-900 mb-1 line-clamp-2 leading-tight group-hover:text-blue-600 transition-colors">{material.title}</h3>
											<p className="text-xs text-gray-500 mb-1">by <span className="font-medium text-gray-700">{material.author}</span></p>
											<p className="text-xs text-gray-500 mb-3 line-clamp-2">{material.description}</p>
											<div className="mt-auto pt-3 border-t border-gray-100 flex justify-between items-center">
												<div className="flex items-center text-xs text-gray-500 gap-3">
													<span className="flex items-center gap-1">{/* File icon logic can be improved if fileType is available */}<FaFilePdf className="text-red-500" /> <span className="uppercase">PDF</span></span>
													<div className="flex items-center gap-1"><FaHeart className="text-gray-400" /><span>{material.likes || 0}</span></div>
												</div>
												<div className="bg-blue-50 text-blue-700 px-2.5 py-1 rounded-md text-sm font-bold shadow-sm border border-blue-100">{material.price} <span className="text-[10px] font-medium text-blue-500">XLM</span></div>
											</div>
											<div className="mt-2 flex justify-between text-xs text-gray-500"><span>{material.subject}</span><span><FaStar className="inline text-yellow-500" /> {material.rating || 4.8}</span></div>
										</div>
									</Link>
								))}
							</motion.div>
							{/* Pagination */}
							{totalPages > 1 && (
								<div className="flex justify-center mt-8 gap-2">
									{Array.from({ length: totalPages }).map((_, i) => (
										<button key={i} onClick={() => setCurrentPage(i + 1)} className={`px-3 py-1.5 rounded ${currentPage === i + 1 ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}>{i + 1}</button>
									))}
								</div>
							)}
						</>
					)}
				</main>
			</section>
		</>
	);
}

export default function MarketPage() {
	return (
		<Suspense fallback={<div className="min-h-screen bg-[#fffaf6]" />}>
			<MarketPageContent />
		</Suspense>
	);
}
