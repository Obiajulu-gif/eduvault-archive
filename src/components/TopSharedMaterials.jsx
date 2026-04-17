"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import { FaCrown } from "react-icons/fa";

export default function TopSharedMaterials() {
	const networkName = "Stellar";
	const priceUnit = "XLM";

	const sharedMaterials = [
		{
			title: "CHM 112 – Lab Report (Year 1)",
			price: `0.25 ${priceUnit}`,
			authorImg: "/author1.png",
		},
		{
			title: "GNS 201 – Use of English (Year 2)",
			price: `0.25 ${priceUnit}`,
			authorImg: "/author2.png",
		},
		{
			title: "CSC 301 – Data Structures (Year 3)",
			price: `0.26 ${priceUnit}`,
			authorImg: "/author3.png",
		},
	];

	const topAuthors = [
		{
			rank: 1,
			name: "CryptoFunks",
			price: `0.25 ${priceUnit}`,
			change: "+26.52%",
			color: "text-green-500",
		},
		{
			rank: 2,
			name: "Cryptix",
			price: `0.25 ${priceUnit}`,
			change: "+10.52%",
			color: "text-red-500",
		},
		{
			rank: 3,
			name: "Frenesware",
			price: `0.25 ${priceUnit}`,
			change: "+5.52%",
			color: "text-green-500",
		},
		{
			rank: 4,
			name: "PunkArt",
			price: `50,008 ${priceUnit}`,
			change: "+1.52%",
			color: "text-green-500",
		},
		{
			rank: 5,
			name: "Art Crypto",
			price: `4,524 ${priceUnit}`,
			change: "+2.52%",
			color: "text-red-500",
		},
	];

	const fadeUp = {
		hidden: { opacity: 0, y: 40 },
		show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: "easeOut" } },
	};

	return (
		<section className="relative py-20 px-6 md:px-20 overflow-hidden">
			{/* 🔹 Background Layer */}
			<div className="absolute inset-0 bg-gradient-to-tr from-yellow-50 via-transparent to-blue-50" />
			<div
				className="absolute inset-0 bg-[linear-gradient(to_right,rgba(0,0,0,0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgba(0,0,0,0.04)_1px,transparent_1px)]
        bg-[size:40px_40px] opacity-30 pointer-events-none"
			/>

			{/* Header */}
			<motion.div
				initial="hidden"
				whileInView="show"
				viewport={{ once: true }}
				variants={fadeUp}
				className="relative flex flex-col md:flex-row md:items-center md:justify-between mb-12 text-center md:text-left z-10"
			>
				<div>
					<h2 className="text-3xl font-bold text-gray-900 mb-2">
						Top Shared Study Materials
					</h2>
					<p className="text-gray-600 text-sm">
						Discover what’s trending in the EduVault community this week.
					</p>
				</div>
				<button className="mt-6 md:mt-0 text-sm font-medium text-blue-600 hover:text-blue-800 transition-all">
					View All Documents →
				</button>
			</motion.div>

			{/* Grid Layout */}
			<div className="relative grid grid-cols-1 md:grid-cols-3 gap-10 z-10 items-start">
				{/* Left — Featured Material */}
				<motion.div
					initial="hidden"
					whileInView="show"
					viewport={{ once: true }}
					variants={fadeUp}
					className="relative h-[340px] rounded-2xl bg-gradient-to-br from-white to-gray-50 border border-gray-100 shadow-sm hover:shadow-lg overflow-hidden transition-all duration-300"
				>
                    <Image
                        src="/images/Generated Image November 07, 2025 - 7_02AM.png"
                        alt="ECN 101 Preview"
                        fill
                        className="object-cover"
                    />
					<div className="absolute bottom-0 w-full bg-white/95 backdrop-blur-md border-t border-gray-200 p-5 flex justify-between items-center">
						<div>
							<h3 className="text-sm font-semibold text-gray-800">
								ECN 101 – Principles of Microeconomics (Year 1)
							</h3>
							<p className="text-xs text-gray-500">
								by{" "}
								<span className="font-medium text-gray-700">Chijioke M.</span>
							</p>
						</div>
						<div className="flex items-center gap-1">
							<span className="inline-flex rounded-full border border-sky-200 bg-sky-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-sky-700">
								{networkName}
							</span>
							<span className="text-xs font-semibold text-gray-700">
								0.25 {priceUnit}
							</span>
						</div>
					</div>
				</motion.div>

				{/* Middle — Shared Materials */}
				<motion.div
					initial="hidden"
					whileInView="show"
					viewport={{ once: true }}
					variants={fadeUp}
					className="flex flex-col space-y-5"
				>
					{sharedMaterials.map((material, i) => (
						<motion.div
							key={i}
							whileHover={{
								scale: 1.02,
								boxShadow: "0 8px 24px rgba(0,0,0,0.08)",
							}}
							className="flex items-center justify-between bg-white border border-gray-100 rounded-2xl p-4 shadow-sm transition-all duration-200"
						>
							<div className="flex items-center gap-3">
								<div className="w-14 h-14 bg-gray-100 rounded-lg flex items-center justify-center text-gray-400 text-lg">
									📘
								</div>
								<div>
									<h3 className="text-sm font-semibold text-gray-800 truncate max-w-[180px]">
										{material.title}
									</h3>
									<div className="flex items-center gap-2 mt-1">
										<span className="inline-flex rounded-full border border-sky-200 bg-sky-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-sky-700">
											{networkName}
										</span>
										<span className="text-xs font-medium text-gray-600">
											{material.price}
										</span>
									</div>
								</div>
							</div>
							<button className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold py-2 px-5 rounded-full shadow-md transition-all duration-200">
								Get This!
							</button>
						</motion.div>
					))}
				</motion.div>

				{/* Right — Top Authors */}
				<motion.div
					initial="hidden"
					whileInView="show"
					viewport={{ once: true }}
					variants={fadeUp}
					className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6"
				>
					<div className="flex items-center gap-2 mb-4">
						<FaCrown className="text-yellow-400 animate-bounce-slow" />
						<h3 className="text-lg font-semibold text-gray-900">
							Top Authors For The Month
						</h3>
					</div>
					<p className="text-xs text-gray-500 mb-6">
						Last <span className="text-orange-500 font-medium">7 days</span>
					</p>
					<div className="space-y-3">
						{topAuthors.map((author) => (
							<motion.div
								key={author.rank}
								whileHover={{
									scale: 1.02,
									backgroundColor: "#f9fafb",
								}}
								className="flex justify-between items-center bg-white border border-gray-100 shadow-sm rounded-xl p-3 transition-all"
							>
								<div className="flex items-center gap-3">
									<div
										className={`w-8 h-8 rounded-full flex items-center justify-center font-semibold text-sm text-gray-800 ${
											author.rank === 1
												? "bg-yellow-100 border border-yellow-300"
												: "bg-gray-100"
										}`}
									>
										{author.rank}
									</div>
									<div>
										<h4 className="text-sm font-semibold text-gray-800">
											{author.name}
										</h4>
										<p className="text-xs text-gray-500">{author.price}</p>
									</div>
								</div>
								<span className={`text-xs font-semibold ${author.color}`}>
									{author.change}
								</span>
							</motion.div>
						))}
					</div>
				</motion.div>
			</div>
		</section>
	);
}
