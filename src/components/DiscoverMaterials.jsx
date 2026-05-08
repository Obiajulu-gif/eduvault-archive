"use client";

import { motion } from "framer-motion";
import Image from "next/image";
import { useEffect, useState } from "react";
import { FaHeart, FaChevronRight } from "react-icons/fa";
import { FiFilter, FiSearch } from "react-icons/fi";

const imageOptions = [
	"/images/Generated Image November 07, 2025 - 6_44AM.png",
	"/images/Generated Image November 07, 2025 - 6_53AM.png",
];

// Likes are randomised once at module load — not during render — to satisfy
// the react-hooks/purity rule (no impure calls inside components or hooks).
const STATIC_MATERIALS = Array.from({ length: 9 }, (_, index) => ({
	title: index % 2 === 0 ? "CHM 112 - Lab Report Template" : "GNS 201 - Advanced Grammar Notes",
	author: index % 3 === 0 ? "Chijioke M." : "Sarah O.",
	likes: Math.floor(Math.random() * 500) + 100,
	price: "0.25 XLM",
	category: index % 3 === 0 ? "Science" : "Arts",
	image: imageOptions[index % imageOptions.length],
}));

export default function DiscoverMaterials() {
	const [loading, setLoading] = useState(true);
	const [activeCategory, setActiveCategory] = useState("All");

	const materials = STATIC_MATERIALS;

	const categories = ["All", "Science", "Engineering", "Arts", "Medical"];

	useEffect(() => {
		const timeout = setTimeout(() => setLoading(false), 1000);
		return () => clearTimeout(timeout);
	}, []);

	const fadeUp = {
		hidden: { opacity: 0, y: 20 },
		show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" } },
	};

	return (
		<section className="relative overflow-hidden bg-white px-6 py-24 md:px-16">
			<div className="absolute top-0 right-0 w-[500px] h-[500px] bg-stellar-blue/5 rounded-full blur-[120px] pointer-events-none" />

			<motion.div
				initial="hidden"
				whileInView="show"
				viewport={{ once: true }}
				variants={fadeUp}
				className="relative z-10 mb-12 flex flex-col md:flex-row md:items-center justify-between gap-6"
			>
				<div>
					<h2 className="text-4xl font-bold text-stellar-dark mb-4">
						Discover the Commons
					</h2>
					<p className="text-edu-muted">Explore thousands of certified academic assets.</p>
				</div>
				<div className="flex items-center gap-3">
					<div className="relative group">
						<FiSearch className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-stellar-blue transition-colors" />
						<input 
							type="text" 
							placeholder="Search materials..." 
							className="bg-edu-light border border-gray-100 rounded-2xl py-3 pl-12 pr-6 text-sm focus:outline-none focus:ring-2 focus:ring-stellar-blue/20 focus:border-stellar-blue transition-all w-full md:w-[300px]"
						/>
					</div>
					<button className="flex items-center gap-2 rounded-2xl border border-gray-100 bg-white px-5 py-3 text-sm font-bold text-stellar-dark transition-all hover:bg-gray-50 shadow-sm">
						<FiFilter /> Filter
					</button>
				</div>
			</motion.div>

			<motion.div
				initial="hidden"
				whileInView="show"
				viewport={{ once: true }}
				variants={fadeUp}
				className="relative z-10 mb-12 flex flex-wrap gap-2"
			>
				{categories.map((cat) => (
					<button
						key={cat}
						onClick={() => setActiveCategory(cat)}
						className={`rounded-xl px-6 py-2.5 text-xs font-bold transition-all duration-300 ${
							activeCategory === cat
								? "bg-stellar-dark text-white shadow-lg"
								: "bg-edu-light text-edu-muted hover:bg-gray-200"
						}`}
					>
						{cat}
					</button>
				))}
			</motion.div>

			<div className="relative z-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3">
				{loading
					? Array(6)
							.fill(0)
							.map((_, i) => (
								<div
									key={i}
									className="h-[400px] animate-pulse rounded-[2.5rem] bg-edu-light"
								/>
							))
					: materials.map((item, i) => (
							<motion.div
								key={i}
								whileHover={{ y: -10 }}
								variants={fadeUp}
								className="group rounded-[2.5rem] border border-gray-100 bg-white p-5 shadow-sm transition-all duration-300 hover:shadow-2xl hover:shadow-stellar-blue/5"
							>
								<div className="mb-6 h-56 overflow-hidden rounded-[2rem] relative bg-edu-light">
									<Image
										src={item.image}
										alt={item.title}
										fill
										className="object-cover transition-transform duration-500 group-hover:scale-110"
									/>
									<div className="absolute top-4 right-4 bg-white/90 backdrop-blur-md px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-sm">
										<FaHeart className="text-pink-500 text-[10px]" />
										<span className="text-[10px] font-bold text-stellar-dark">{item.likes}</span>
									</div>
								</div>

								<div className="flex flex-col flex-grow">
									<div className="flex items-center gap-2 mb-3">
										<span className="text-[10px] font-bold text-stellar-blue uppercase tracking-widest">{item.category}</span>
									</div>
									<h3 className="mb-2 text-lg font-bold text-stellar-dark line-clamp-1">
										{item.title}
									</h3>
									<p className="mb-6 text-sm text-edu-muted">By {item.author}</p>

									<div className="mt-auto pt-6 border-t border-gray-50 flex items-center justify-between">
										<div className="flex flex-col">
											<span className="text-[10px] uppercase tracking-wider text-edu-muted font-bold">Price</span>
											<span className="text-lg font-black text-stellar-dark">
												{item.price}
											</span>
										</div>
										<button className="bg-stellar-blue/5 hover:bg-stellar-blue text-stellar-blue hover:text-white p-4 rounded-2xl transition-all duration-300">
											<FaChevronRight />
										</button>
									</div>
								</div>
							</motion.div>
					  ))}
			</div>

			<motion.div
				initial={{ opacity: 0, y: 20 }}
				whileInView={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.5 }}
				className="relative z-10 mt-20 flex justify-center"
			>
				<button className="flex items-center gap-3 rounded-2xl bg-stellar-dark text-white px-10 py-4 font-bold transition-all duration-300 hover:scale-105 shadow-xl shadow-stellar-dark/20">
					Load More Materials
				</button>
			</motion.div>
		</section>
	);
}
