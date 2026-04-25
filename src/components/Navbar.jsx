"use client";

import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatAddress } from "@/utils/formatAddress";
import { WalletButton } from "./WalletBtn";
import { useWallet } from "@/hooks/useWallet";

export default function Navbar() {
	const [menuOpen, setMenuOpen] = useState(false);
	const router = useRouter();

	const {
		address,
		isConnected,
		balances,
		disconnect
	} = useWallet();
	const balance = balances?.snapshot?.native?.balance;
	const balanceSymbol = 'XLM';

	return (
		<header className="relative flex justify-center py-6 px-4 md:px-0 overflow-visible bg-[#fffaf6] z-11111">
			{/* 🔹 Background Grid Pattern */}
			<div
				className="absolute inset-0 bg-[linear-gradient(to_right,#f2ede8_1px,transparent_1px),linear-gradient(to_bottom,#f2ede8_1px,transparent_1px)] bg-[size:40px_40px] opacity-70 pointer-events-none"
				aria-hidden="true"
			></div>

			{/* 🔹 Floating Navbar */}
			<motion.nav
				initial={{ y: -40, opacity: 0 }}
				animate={{ y: 0, opacity: 1 }}
				transition={{ duration: 0.6, ease: "easeOut" }}
				className="relative flex items-center justify-between w-full md:w-[90%] lg:w-[85%] max-w-6xl 
        bg-white/80 backdrop-blur-lg border border-gray-200 rounded-full py-3 px-6 md:px-10 shadow-sm z-10"
			>
				{/* Logo */}
				<div className="flex items-center gap-3">
					{/* Image placed to the left of the site name. Put your file at /public/images/logo.png */}
					<Image
						src="/logo.png"
						alt="EduVault Logo"
						width={40}
						height={40}
						className="rounded-full object-cover"
					/>
					<div className="text-lg font-bold tracking-tight text-gray-900">
						EduVault.
					</div>
				</div>

				{/* Desktop Menu */}
				<div className="hidden md:flex items-center space-x-10 text-sm font-medium text-gray-700">
					<Link
						href="/#howitworks"
						className="hover:text-gray-900 transition-all duration-200"
					>
						How It Works
					</Link>
					<Link
						href="/marketplace"
						className="hover:text-gray-900 transition-all duration-200"
					>
						Marketplace
					</Link>
					<Link
						href="https://edu-vault.gitbook.io/edu-vault-docs/"
						className="hover:text-gray-900 transition-all duration-200"
					>
						Docs
					</Link>
				</div>

				{/* Connect Wallet Button / Connected State */}
				{isConnected && address ? (
					<div className="hidden md:flex items-center gap-3">
						{/* Balance Display (optional) */}
						{balance && (
							<div className="text-xs text-gray-600 font-medium">
								{parseFloat(balance).toFixed(3)} {balanceSymbol}
							</div>
						)}

						{/* Connected Address Button */}
						<div className="relative group">
							<button
								onClick={() => router.push("/dashboard")}
								className="flex items-center gap-2 bg-green-50 hover:bg-green-100 text-green-700 border border-green-300 
                                text-sm font-semibold py-2 px-5 rounded-full transition-all duration-300"
							>
								<div className="w-2 h-2 bg-green-500 rounded-full"></div>
								{formatAddress(address)}
							</button>

							{/* Dropdown menu on hover */}
							<div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50">
								<Link
									href="/dashboard"
									className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-t-lg"
								>
									View Profile
								</Link>
								<button
									onClick={disconnect}
									className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 rounded-b-lg"
								>
									Disconnect
								</button>
							</div>
						</div>
					</div>
				) : (
					<WalletButton	/>
				)}

				{/* Mobile Menu Button */}
				<button
					className="md:hidden flex flex-col space-y-1"
					onClick={() => setMenuOpen(!menuOpen)}
				>
					<span className="w-5 h-0.5 bg-black"></span>
					<span className="w-5 h-0.5 bg-black"></span>
					<span className="w-5 h-0.5 bg-black"></span>
				</button>

				{/* Mobile Dropdown Menu */}
				{menuOpen && (
					<div className="absolute top-20 left-0 w-full bg-white border-t border-gray-200 shadow-sm flex flex-col items-center space-y-4 py-6 text-gray-700 md:hidden z-50">
						<Link href="/#howitwork">How It Works</Link>
						<Link href="/marketplace">Marketplace</Link>
						<Link href="https://edu-vault.gitbook.io/edu-vault-docs/">
							Docs
						</Link>

						{/* Mobile wallet button/state */}
						{isConnected && address ? (
							<div className="flex flex-col items-center gap-3 w-full px-4">
								<div className="flex items-center gap-2 text-sm font-semibold text-green-700">
									<div className="w-2 h-2 bg-green-500 rounded-full"></div>
									{formatAddress(address)}
								</div>
								{balance && (
									<div className="text-xs text-gray-600">
										{parseFloat(balance).toFixed(3)} {balanceSymbol}
									</div>
								)}
								<div className="flex gap-2 w-full">
									<Link
										href="/dashboard"
										onClick={() => setMenuOpen(false)}
										className="flex-1 bg-gray-100 hover:bg-gray-200 text-sm font-semibold py-2 px-4 rounded-full text-center"
									>
										Profile
									</Link>
									<button
										onClick={() => {
											setMenuOpen(false);
											disconnect();
										}}
										className="flex-1 bg-red-50 hover:bg-red-100 text-red-600 text-sm font-semibold py-2 px-4 rounded-full"
									>
										Disconnect
									</button>
								</div>
							</div>
						) : (
							<WalletButton	/>
						)}
					</div>
				)}
			</motion.nav>
		</header>
	);
}
