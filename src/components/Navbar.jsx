"use client";

import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { formatAddress } from "@/utils/formatAddress";
import { WalletButton } from "./WalletBtn";
import { useWallet } from "@/hooks/useWallet";

export default function Navbar() {
	const [menuOpen, setMenuOpen] = useState(false);
	const [scrolled, setScrolled] = useState(false);
	const router = useRouter();

	const {
		address,
		isConnected,
		balances,
		disconnect
	} = useWallet();
	const balance = balances?.snapshot?.native?.balance;
	const balanceSymbol = 'XLM';

	useEffect(() => {
		const handleScroll = () => {
			setScrolled(window.scrollY > 20);
		};
		window.addEventListener("scroll", handleScroll);
		return () => window.removeEventListener("scroll", handleScroll);
	}, []);

	return (
		<header 
			className={`fixed top-0 left-0 right-0 flex justify-center py-4 px-4 md:px-0 z-[100] transition-all duration-300 ${
				scrolled ? "bg-white/10 backdrop-blur-xl py-3" : "bg-transparent"
			}`}
		>
			<motion.nav
				initial={{ y: -40, opacity: 0 }}
				animate={{ y: 0, opacity: 1 }}
				transition={{ duration: 0.6, ease: "easeOut" }}
				className={`flex items-center justify-between w-full md:w-[90%] lg:w-[85%] max-w-6xl 
        ${scrolled ? "bg-white/90" : "bg-white/80"} backdrop-blur-lg border border-gray-200/50 rounded-full py-2.5 px-6 md:px-10 shadow-lg shadow-black/5 z-10 transition-all duration-300`}
			>
				{/* Logo */}
				<Link href="/" className="flex items-center gap-2.5 group">
					<div className="relative w-9 h-9 rounded-full overflow-hidden border-2 border-stellar-blue/20 group-hover:border-stellar-blue/50 transition-colors">
						<Image
							src="/logo.png"
							alt="EduVault Logo"
							fill
							className="object-cover"
						/>
					</div>
					<div className="text-xl font-bold tracking-tight text-stellar-dark">
						EduVault<span className="text-stellar-blue">.</span>
					</div>
				</Link>

				{/* Desktop Menu */}
				<div className="hidden md:flex items-center space-x-8 text-sm font-semibold text-gray-600">
					<Link
						href="/#howitworks"
						className="hover:text-stellar-blue transition-all duration-200"
					>
						How It Works
					</Link>
					<Link
						href="/marketplace"
						className="hover:text-stellar-blue transition-all duration-200"
					>
						Marketplace
					</Link>
					<Link
						href="https://edu-vault.gitbook.io/edu-vault-docs/"
						target="_blank"
						className="hover:text-stellar-blue transition-all duration-200"
					>
						Docs
					</Link>
				</div>

				{/* Actions */}
				<div className="flex items-center gap-4">
					{isConnected && address ? (
						<div className="hidden md:flex items-center gap-4">
							{balance && (
								<div className="hidden lg:flex flex-col items-end">
									<span className="text-[10px] uppercase tracking-wider text-gray-400 font-bold">Balance</span>
									<span className="text-xs text-gray-900 font-bold">
										{parseFloat(balance).toFixed(2)} {balanceSymbol}
									</span>
								</div>
							)}

							<div className="relative group">
								<button
									onClick={() => router.push("/dashboard")}
									className="flex items-center gap-2 bg-stellar-dark text-white hover:bg-stellar-dark/90 
																	text-sm font-bold py-2.5 px-5 rounded-full transition-all duration-300 shadow-md shadow-stellar-dark/10"
								>
									<div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
									{formatAddress(address)}
								</button>

								<div className="absolute right-0 mt-3 w-48 bg-white rounded-2xl shadow-xl border border-gray-100 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50 p-2 overflow-hidden">
									<Link
										href="/dashboard"
										className="flex items-center px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 rounded-xl transition-colors"
									>
										Dashboard
									</Link>
									<button
										onClick={disconnect}
										className="flex items-center w-full text-left px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 rounded-xl transition-colors"
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
						className="md:hidden flex flex-col space-y-1.5 p-2"
						onClick={() => setMenuOpen(!menuOpen)}
					>
						<span className={`w-5 h-0.5 bg-stellar-dark transition-transform ${menuOpen ? "rotate-45 translate-y-2" : ""}`}></span>
						<span className={`w-5 h-0.5 bg-stellar-dark transition-opacity ${menuOpen ? "opacity-0" : ""}`}></span>
						<span className={`w-5 h-0.5 bg-stellar-dark transition-transform ${menuOpen ? "-rotate-45 -translate-y-2" : ""}`}></span>
					</button>
				</div>

				{/* Mobile Dropdown Menu */}
				{menuOpen && (
					<motion.div 
						initial={{ opacity: 0, scale: 0.95 }}
						animate={{ opacity: 1, scale: 1 }}
						className="absolute top-full left-0 right-0 mt-4 mx-4 bg-white border border-gray-100 rounded-3xl shadow-2xl flex flex-col items-center space-y-4 py-8 text-gray-700 md:hidden z-50"
					>
						<Link href="/#howitworks" onClick={() => setMenuOpen(false)} className="text-lg font-bold">How It Works</Link>
						<Link href="/marketplace" onClick={() => setMenuOpen(false)} className="text-lg font-bold">Marketplace</Link>
						<Link href="https://edu-vault.gitbook.io/edu-vault-docs/" onClick={() => setMenuOpen(false)} className="text-lg font-bold">Docs</Link>

						<div className="w-full px-8 pt-4">
							{isConnected && address ? (
								<div className="flex flex-col items-center gap-4 w-full">
									<div className="flex items-center gap-2 text-sm font-bold text-stellar-dark bg-gray-100 px-4 py-2 rounded-full">
										<div className="w-2 h-2 bg-green-500 rounded-full"></div>
										{formatAddress(address)}
									</div>
									<div className="flex gap-2 w-full">
										<Link
											href="/dashboard"
											onClick={() => setMenuOpen(false)}
											className="flex-1 bg-stellar-dark text-white text-sm font-bold py-3 px-4 rounded-2xl text-center"
										>
											Dashboard
										</Link>
										<button
											onClick={() => {
												setMenuOpen(false);
												disconnect();
											}}
											className="flex-1 bg-red-50 text-red-600 text-sm font-bold py-3 px-4 rounded-2xl"
										>
											Log Out
										</button>
									</div>
								</div>
							) : (
								<div className="flex justify-center w-full">
									<WalletButton	/>
								</div>
							)}
						</div>
					</motion.div>
				)}
			</motion.nav>
		</header>
	);
}
