"use client";

import { motion } from "framer-motion";
import { useState, useEffect, useMemo } from "react";
import { FaHeart } from "react-icons/fa";
import { FiFilter } from "react-icons/fi";

export default function DiscoverMaterials() {
	const [loading, setLoading] = useState(true);
	const priceUnit = "XLM";

    const imageOptions = [
        "/images/Generated Image November 07, 2025 - 6_44AM.png",
        "/images/Generated Image November 07, 2025 - 6_53AM.png",
    ];

    const materials = useMemo(() =>
        Array.from({ length: 9 }).map(() => ({
            title: "CHM 112 – Lab Report Template (UNN)",
            author: "Chijioke M.",
            likes: "21.5K",
            bid: `0.25 ${priceUnit}`,
            time: "01:09:40",
            image: imageOptions[Math.floor(Math.random() * imageOptions.length)],
        })),
        []
    );

	const categories = ["All", "Social Sciences", "Engineering", "Pharmacy"];
	const [activeCategory, setActiveCategory] = useState("All");

	useEffect(() => {
		const timeout = setTimeout(() => setLoading(false), 1200);
		return () => clearTimeout(timeout);
	}, []);

	const fadeUp = {
		hidden: { opacity: 0, y: 40 },
		show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" } },
	};

	return (
		<section className="relative py-20 px-6 md:px-16 bg-gradient-to-br from-white to-blue-50 overflow-hidden">
			{/* Decorative Grid Background */}
			<div
				className="absolute inset-0 bg-[linear-gradient(to_right,rgba(0,0,0,0.03)_1px,transparent_1px),linear-gradient(to_bottom,rgba(0,0,0,0.03)_1px,transparent_1px)]
        bg-[size:50px_50px] opacity-30 pointer-events-none"
			/>

			{/* Header */}
			<motion.div
				initial="hidden"
				whileInView="show"
				viewport={{ once: true }}
				variants={fadeUp}
				className="relative flex flex-col md:flex-row md:items-center justify-between mb-10 z-10"
			>
				<h2 className="text-3xl font-bold text-gray-900 mb-4 md:mb-0">
					Discover More Study Materials
				</h2>
				<button className="flex items-center gap-2 border border-gray-300 text-gray-700 text-sm py-2.5 px-5 rounded-full hover:bg-gray-100 transition-all">
					<FiFilter /> Filter
				</button>
			</motion.div>

			{/* Category Buttons */}
			<motion.div
				initial="hidden"
				whileInView="show"
				viewport={{ once: true }}
				variants={fadeUp}
				className="flex flex-wrap gap-3 mb-12 relative z-10"
			>
				{categories.map((cat, i) => (
					<button
						key={i}
						onClick={() => setActiveCategory(cat)}
						className={`text-sm font-medium px-5 py-2.5 rounded-full border transition-all duration-300 ${
							activeCategory === cat
								? "bg-blue-600 text-white border-blue-600 shadow-md"
								: "border-gray-300 text-gray-700 hover:bg-gray-100"
						}`}
					>
						{cat}
					</button>
				))}
			</motion.div>

			{/* Materials Grid */}
			<motion.div
				initial="hidden"
				whileInView="show"
				viewport={{ once: true }}
				className="relative grid sm:grid-cols-2 lg:grid-cols-3 gap-8 z-10"
			>
				{loading
					? Array(6)
							.fill(0)
							.map((_, i) => (
								<div
									key={i}
									className="animate-pulse bg-gray-100 border border-gray-200 rounded-2xl p-4 h-[320px]"
								>
									<div className="bg-gray-200 h-48 w-full rounded-xl mb-4"></div>
									<div className="bg-gray-200 h-4 w-3/4 mb-2 rounded"></div>
									<div className="bg-gray-200 h-3 w-1/2 mb-3 rounded"></div>
									<div className="bg-gray-200 h-3 w-1/3 rounded"></div>
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
								className="bg-white border border-gray-200 rounded-2xl p-4 shadow-sm hover:shadow-lg transition-all duration-300"
							>
                                {/* Thumbnail */}
                                <div className="bg-gray-100 rounded-xl h-48 mb-4 overflow-hidden">
                                    <img
                                        src={item.image}
                                        alt={item.title}
                                        className="h-full w-full object-cover"
                                    />
                                </div>

								{/* CTA Button */}
								<button className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold py-2 px-5 rounded-full mb-4 transition-all">
									Get This!
								</button>

								{/* Text Info */}
								<h3 className="text-sm font-semibold text-gray-800 mb-1 truncate">
									{item.title}
								</h3>
								<p className="text-xs text-gray-500 mb-3">by {item.author}</p>

								{/* Meta Info */}
								<div className="flex justify-between items-center text-xs text-gray-500 mb-1">
									<div className="flex items-center gap-1">
										<FaHeart className="text-pink-500" />
										<span>{item.likes} Likes</span>
									</div>
									<span>Current Bid</span>
								</div>

								{/* Bid + Time */}
								<div className="flex justify-between items-center mt-1">
									<span className="text-xs text-gray-500 flex items-center gap-1">
										⏱ {item.time}
									</span>
									<span className="text-sm font-semibold text-gray-800">
										{item.bid}
									</span>
								</div>
							</motion.div>
					  ))}
			</motion.div>

			{/* Load More Button */}
			<motion.div
				initial={{ opacity: 0, y: 20 }}
				whileInView={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.5 }}
				className="flex justify-center mt-16 relative z-10"
			>
				<button className="flex items-center gap-2 border border-gray-300 text-gray-700 text-sm py-2.5 px-6 rounded-full hover:bg-gray-100 transition-all duration-300">
					Load More
				</button>
			</motion.div>
		</section>
	);
}
