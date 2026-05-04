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
	FaCog,
	FaBoxOpen,
} from "react-icons/fa";

export default function Sidebar() {
	const pathname = usePathname();

	const menuItems = [
		{ icon: <FaTachometerAlt />, label: "Dashboard", href: "/dashboard" },
		{ icon: <FaShoppingBag />, label: "Market", href: "/dashboard/market" },
		{ icon: <FaUpload />, label: "Upload Material", href: "/dashboard/upload" },
		{ icon: <FaAward />, label: "Leaderboard", href: "/dashboard/leaderboard" },
	];

	const profileItems = [
		{
			icon: <FaUser />,
			label: "My Materials",
			href: "/dashboard/my-materials",
		},
		{
			icon: <FaBoxOpen />,
			label: "My Purchases",
			href: "/dashboard/purchases",
		},
		{ icon: <FaDollarSign />, label: "Earnings", href: "/dashboard/earnings" },
		{ icon: <FaHeart />, label: "Favourites", href: "/dashboard/favourites" },
		{ icon: <FaHistory />, label: "History", href: "/dashboard/history" },
		{ icon: <FaCog />, label: "Settings", href: "/dashboard/settings" },
	];

	const isActive = (href) => pathname === href;

	return (
		<aside className="w-64 bg-white border-r border-gray-200 p-6 flex flex-col fixed h-full">
			<div className="text-2xl font-bold mb-8">EduVault</div>

			{/* Main Menu */}
			<nav className="space-y-1 mb-8">
				{menuItems.map((item, i) => (
					<Link
						key={i}
						href={item.href}
						className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
							isActive(item.href)
								? "bg-blue-50 text-blue-600 border-l-4 border-blue-600 font-semibold"
								: "text-gray-700 hover:bg-gray-100"
						}`}
					>
						{item.icon}
						<span>{item.label}</span>
					</Link>
				))}
			</nav>

			{/* Profile Menu */}
			<div className="mb-8">
				<h3 className="text-sm font-semibold text-gray-500 mb-3 px-4">
					PROFILE
				</h3>
				<nav className="space-y-1">
					{profileItems.map((item, i) => (
						<Link
							key={i}
							href={item.href}
							className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
								isActive(item.href)
									? "bg-blue-50 text-blue-600 border-l-4 border-blue-600 font-semibold"
									: "text-gray-700 hover:bg-gray-100"
							}`}
						>
							{item.icon}
							<span>{item.label}</span>
						</Link>
					))}
				</nav>
			</div>

			{/* Wallet Summary */}
			<div className="mt-auto p-4 bg-gradient-to-br from-blue-600 to-blue-500 text-white rounded-xl">
				<div className="text-3xl font-bold mb-1">5,034.02</div>
				<div className="text-sm opacity-90 mb-4">Soroban pending</div>
				<button className="bg-white text-blue-600 font-semibold py-2 px-3 w-full rounded-md hover:bg-gray-100">
					Top Up Balance
				</button>
			</div>
		</aside>
	);
}
