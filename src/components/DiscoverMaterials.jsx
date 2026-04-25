"use client";

import { motion } from "framer-motion";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { FaHeart } from "react-icons/fa";
import { FiFilter } from "react-icons/fi";

const imageOptions = [
	"/images/Generated Image November 07, 2025 - 6_44AM.png",
	"/images/Generated Image November 07, 2025 - 6_53AM.png",
];

export default function DiscoverMaterials() {
	const [loading, setLoading] = useState(true);
	const [activeCategory, setActiveCategory] = useState("All");

	const materials = useMemo(
		() =>
			Array.from({ length: 9 }, (_, index) => ({
				title: "CHM 112 â€“ Lab Report Template (UNN)",
				author: "Chijioke M.",
				likes: "21.5K",
				bid: "0.25 XLM",
				time: "01:09:40",
				image: imageOptions[index % imageOptions.length],
			})),
		[]
	);

	const categories = ["All", "Social Sciences", "Engineering", "Pharmacy"];

	useEffect(() => {
		const timeout = setTimeout(() => setLoading(false), 1200);
		return () => clearTimeout(timeout);
	}, []);

	const fadeUp = {
		hidden: { opacity: 0, y: 40 },
		show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" } },
	};

	return (
		<section className="relative overflow-hidden bg-gradient-to-br from-white to-blue-50 px-6 py-20 md:px-16">
			<div
				className="absolute inset-0 bg-[linear-gradient(to_right,rgba(0,0,0,0.03)_1px,transparent_1px),linear-gradient(to_bottom,rgba(0,0,0,0.03)_1px,transparent_1px)] bg-[size:50px_50px] opacity-30 pointer-events-none"
			/>

			<motion.div
				initial="hidden"
				whileInView="show"
				viewport={{ once: true }}
				variants={fadeUp}
				className="relative z-10 mb-10 flex flex-col justify-between md:flex-row md:items-center"
			>
				<h2 className="mb-4 text-3xl font-bold text-gray-900 md:mb-0">
					Discover More Study Materials
				</h2>
				<button className="flex items-center gap-2 rounded-full border border-gray-300 px-5 py-2.5 text-sm text-gray-700 transition-all hover:bg-gray-100">
					<FiFilter /> Filter
				</button>
			</motion.div>

			<motion.div
				initial="hidden"
				whileInView="show"
				viewport={{ once: true }}
				variants={fadeUp}
				className="relative z-10 mb-12 flex flex-wrap gap-3"
			>
				{categories.map((cat) => (
					<button
						key={cat}
						onClick={() => setActiveCategory(cat)}
						className={`rounded-full border px-5 py-2.5 text-sm font-medium transition-all duration-300 ${
							activeCategory === cat
								? "border-blue-600 bg-blue-600 text-white shadow-md"
								: "border-gray-300 text-gray-700 hover:bg-gray-100"
						}`}
					>
						{cat}
					</button>
				))}
			</motion.div>

			<motion.div
				initial="hidden"
				whileInView="show"
				viewport={{ once: true }}
				className="relative z-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-3"
			>
				{loading
					? Array(6)
							.fill(0)
							.map((_, i) => (
								<div
									key={i}
									className="h-[320px] animate-pulse rounded-2xl border border-gray-200 bg-gray-100 p-4"
								>
									<div className="mb-4 h-48 w-full rounded-xl bg-gray-200" />
									<div className="mb-2 h-4 w-3/4 rounded bg-gray-200" />
									<div className="mb-3 h-3 w-1/2 rounded bg-gray-200" />
									<div className="h-3 w-1/3 rounded bg-gray-200" />
								</div>
							))
					: materials.map((item, i) => (
							<motion.div
								key={i}
								whileHover={{
									scale: 1.03,
									boxShadow: "0 10px 25px rgba(0,0,0,0.1)",
								}}
								variants={fadeUp}
								className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm transition-all duration-300 hover:shadow-lg"
							>
								<div className="mb-4 h-48 overflow-hidden rounded-xl bg-gray-100">
									<Image
										src={item.image}
										alt={item.title}
										fill
										className="object-cover"
									/>
								</div>

								<button className="mb-4 rounded-full bg-blue-600 px-5 py-2 text-xs font-semibold text-white transition-all hover:bg-blue-700">
									Get This!
								</button>

								<h3 className="mb-1 truncate text-sm font-semibold text-gray-800">
									{item.title}
								</h3>
								<p className="mb-3 text-xs text-gray-500">by {item.author}</p>

								<div className="mb-1 flex items-center justify-between text-xs text-gray-500">
									<div className="flex items-center gap-1">
										<FaHeart className="text-pink-500" />
										<span>{item.likes} Likes</span>
									</div>
									<span>Current Bid</span>
								</div>

								<div className="mt-1 flex items-center justify-between">
									<span className="flex items-center gap-1 text-xs text-gray-500">
										â± {item.time}
									</span>
									<span className="text-sm font-semibold text-gray-800">
										{item.bid}
									</span>
								</div>
							</motion.div>
					  ))}
			</motion.div>

			<motion.div
				initial={{ opacity: 0, y: 20 }}
				whileInView={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.5 }}
				className="relative z-10 mt-16 flex justify-center"
			>
				<button className="flex items-center gap-2 rounded-full border border-gray-300 px-6 py-2.5 text-sm text-gray-700 transition-all duration-300 hover:bg-gray-100">
					Load More
				</button>
			</motion.div>
		</section>
	);
}
