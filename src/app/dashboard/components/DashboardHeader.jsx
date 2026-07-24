"use client";

import { useState } from "react";
import { FaSearch } from "react-icons/fa";
import { FiUpload } from "react-icons/fi";
import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import ThemeToggle from "@/components/ThemeToggle";

export default function DashboardHeader() {
	const [activeTab, setActiveTab] = useState("User");

	return (
		<header className="bg-surface/90 border-b border-border-subtle px-8 py-4 flex items-center justify-between sticky top-0 z-40 backdrop-blur-md" role="banner">
			<div
				initial={{ opacity: 0, y: -10 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.4 }}
				className="flex-1 max-w-xl relative"
			>
				<FaSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
				<label htmlFor="dashboard-search" className="sr-only">Search items, collections and accounts</label>
				<input
					id="dashboard-search"
					type="text"
					placeholder="Search Item, Collection and Account..."
					className="w-full pl-10 pr-4 py-3 bg-surface-strong text-sm border border-border-subtle rounded-full shadow-sm focus:outline-none focus:ring-2 focus:ring-stellar-blue/20 transition-all text-foreground placeholder:text-muted-foreground"
				/>
			</div>

			<div className="flex items-center gap-4 ml-6">
				<ThemeToggle />

				<div className="flex items-center bg-surface-strong border border-border-subtle rounded-full p-1 shadow-sm" role="tablist" aria-label="View mode">
					<button
						onClick={() => setActiveTab("User")}
						role="tab"
						aria-selected={activeTab === "User"}
						className={`px-4 py-1.5 text-sm font-medium rounded-full transition-all focus-visible:ring-2 focus-visible:ring-blue-500 ${
							activeTab === "User"
								? "bg-gradient-to-r from-blue-500 to-purple-500 text-white shadow-md"
								: "text-muted-foreground hover:text-foreground"
						}`}
					>
						User
					</button>
					<button
						onClick={() => setActiveTab("Creator")}
						role="tab"
						aria-selected={activeTab === "Creator"}
						className={`px-4 py-1.5 text-sm font-medium rounded-full transition-all focus-visible:ring-2 focus-visible:ring-blue-500 ${
							activeTab === "Creator"
								? "bg-gradient-to-r from-blue-500 to-purple-500 text-white shadow-md"
								: "text-muted-foreground hover:text-foreground"
						}`}
					>
						Creator
					</button>
				</div>

				<Link
					href="/dashboard/upload"
					className="w-10 h-10 flex items-center justify-center rounded-full bg-surface-strong border border-border-subtle hover:bg-surface-muted hover:border-stellar-blue/30 text-muted-foreground hover:text-stellar-blue shadow-sm transition-all duration-300 focus-visible:ring-2 focus-visible:ring-blue-500"
					aria-label="Upload Material"
				>
					<FiUpload size={18} aria-hidden="true" />
				</Link>

				<div className="w-10 h-10 rounded-full overflow-hidden border border-border-strong shadow-sm">
					<Image
						src="/images/profile.png"
						alt="Your profile"
						width={40}
						height={40}
						className="object-cover w-full h-full"
					/>
				</div>
			</div>
		</header>
	);
}
