"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
	FaTachometerAlt,
	FaShoppingBag,
	FaUpload,
	FaAward,
	FaUser,
	FaDollarSign,
	FaHeart,
	FaHistory,
	FaBoxOpen,
	FaFileUpload,
	FaWallet,
	FaRocket,
	FaGraduationCap,
} from "react-icons/fa";

export default function Sidebar() {
	const pathname = usePathname();

	const mainItems = [
		{ icon: <FaTachometerAlt />, label: "Dashboard", href: "/dashboard" },
		{ icon: <FaShoppingBag />, label: "Marketplace", href: "/dashboard/market" },
		{ icon: <FaGraduationCap />, label: "Learner Hub", href: "/dashboard/learner" },
	];

	const creatorItems = [
		{ icon: <FaUpload />, label: "Upload Material", href: "/dashboard/upload" },
		{ icon: <FaFileUpload />, label: "Bulk Upload", href: "/dashboard/bulk-upload" },
		{ icon: <FaUser />, label: "My Materials", href: "/dashboard/my-materials" },
	];

	const financeItems = [
		{ icon: <FaDollarSign />, label: "Earnings", href: "/dashboard/earnings" },
		{ icon: <FaWallet />, label: "Payout Settings", href: "/dashboard/settings" },
	];

	const learnerItems = [
		{ icon: <FaBoxOpen />, label: "My Purchases", href: "/dashboard/purchases" },
		{ icon: <FaHeart />, label: "Favourites", href: "/dashboard/favourites" },
		{ icon: <FaHistory />, label: "History", href: "/dashboard/history" },
	];

	const exploreItems = [
		{ icon: <FaAward />, label: "Leaderboard", href: "/dashboard/leaderboard" },
	];

	const isActive = (href) => pathname === href;

	const renderNavSection = (items, label) => (
		<div className="mb-6">
			<h3 className="text-xs font-semibold text-muted-foreground mb-2 px-4 uppercase tracking-wider">
				{label}
			</h3>
			<nav className="space-y-1" aria-label={`${label} navigation`}>
				{items.map((item, i) => (
					<Link
						key={i}
						href={item.href}
						className={`flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm transition-all focus-visible:ring-2 focus-visible:ring-blue-500 ${
							isActive(item.href)
								? "bg-blue-50 text-blue-600 border-l-4 border-blue-600 font-semibold"
								: "text-muted-foreground hover:bg-surface-muted hover:text-foreground"
						}`}
					>
						<span aria-hidden="true">{item.icon}</span>
						<span>{item.label}</span>
					</Link>
				))}
			</nav>
		</div>
	);

	return (
		<aside className="w-64 bg-surface-strong border-r border-border-subtle p-6 flex flex-col fixed h-full overflow-y-auto" aria-label="Dashboard sidebar navigation">
			<div className="text-2xl font-bold mb-8 shrink-0">
				<Link href="/dashboard" aria-label="EduVault Dashboard Home">EduVault</Link>
			</div>

			<div className="flex-1 overflow-y-auto">
				{renderNavSection(mainItems, "Main")}
				{renderNavSection(creatorItems, "Create & Manage")}
				{renderNavSection(financeItems, "Finances")}
				{renderNavSection(learnerItems, "Learning")}
				{renderNavSection(exploreItems, "Explore")}
			</div>

			<div className="mt-auto p-4 bg-gradient-to-br from-blue-600 to-blue-500 text-white rounded-xl" role="region" aria-label="Wallet summary">
				<div className="text-3xl font-bold mb-1" aria-label="Balance: 5,034.02 Soroban">5,034.02</div>
				<div className="text-sm opacity-90 mb-4">Soroban pending</div>
				<button className="bg-white text-blue-600 font-semibold py-2 px-3 w-full rounded-md hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none" aria-label="Top up wallet balance">
					Top Up Balance
				</button>
			</div>
		</aside>
	);
}
