"use client";

import { useState } from "react";
import { FiUpload } from "react-icons/fi";
import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import ThemeToggle from "@/components/ThemeToggle";
import SearchBox from "@/components/SearchBox";

export default function DashboardHeader() {
	const [activeTab, setActiveTab] = useState("User");

	return (
		<header className="bg-surface/90 border-b border-border-subtle px-8 py-4 flex items-center justify-between sticky top-0 z-40 backdrop-blur-md">
			{/* Search Bar */}
			<motion.div
				initial={{ opacity: 0, y: -10 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.4 }}
				className="flex-1 max-w-xl relative"
			>
				<SearchBox placeholder="Search Item, Collection and Account..." />
			</motion.div>

			{/* Right Section */}
			<div className="flex items-center gap-4 ml-6">
				<ThemeToggle />

				{/* User/Creator Toggle */}
				<div className="flex items-center bg-surface-strong border border-border-subtle rounded-full p-1 shadow-sm">
					<button
						onClick={() => setActiveTab("User")}
						className={`px-4 py-1.5 text-sm font-medium rounded-full transition-all ${
							activeTab === "User"
								? "bg-gradient-to-r from-blue-500 to-purple-500 text-white shadow-md"
								: "text-muted-foreground hover:text-foreground"
						}`}
					>
						User
					</button>
					<button
						onClick={() => setActiveTab("Creator")}
						className={`px-4 py-1.5 text-sm font-medium rounded-full transition-all ${
							activeTab === "Creator"
								? "bg-gradient-to-r from-blue-500 to-purple-500 text-white shadow-md"
								: "text-muted-foreground hover:text-foreground"
						}`}
					>
						Creator
					</button>
				</div>

				{/* Upload Button (Icon Only) */}
				<Link
					href="/dashboard/upload"
					className="w-10 h-10 flex items-center justify-center rounded-full bg-surface-strong border border-border-subtle hover:bg-surface-muted hover:border-stellar-blue/30 text-muted-foreground hover:text-stellar-blue shadow-sm transition-all duration-300"
					title="Upload Material"
				>
					<FiUpload size={18} />
				</Link>

				{/* Profile Avatar */}
				<div className="w-10 h-10 rounded-full overflow-hidden border border-border-strong shadow-sm">
					<Image
						src="/images/profile.png"
						alt="Profile"
						width={40}
						height={40}
						className="object-cover w-full h-full"
					/>
				</div>
			</div>
		</header>
	);
}
