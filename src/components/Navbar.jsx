"use client";

import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { formatAddress } from "@/utils/formatAddress";
import { WalletButton } from "./WalletBtn";
import { useWallet } from "@/hooks/useWallet";
import { useCart } from "@/hooks/useCart";
import ThemeToggle from "./ThemeToggle";
import { WalletStatus } from "@/providers/WalletProvider";
import { FaShoppingCart, FaExternalLinkAlt, FaCopy, FaCheck } from "react-icons/fa";
import { getExplorerAccountUrl } from "@/lib/config/chain";
import NotificationCenter from "./notifications/NotificationCenter";

export default function Navbar() {
	const [menuOpen, setMenuOpen] = useState(false);
	const [scrolled, setScrolled] = useState(false);
	const router = useRouter();
	const { cartItems, setIsCartOpen } = useCart();
	const [copied, setCopied] = useState(false);
	const menuRef = useRef(null);
	const menuButtonRef = useRef(null);
	const walletDropdownRef = useRef(null);

	const handleCopy = () => {
		if (address) {
			navigator.clipboard.writeText(address);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	};

	const {
		address,
		isConnected,
		state,
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

	const closeMenu = useCallback(() => {
		setMenuOpen(false);
		menuButtonRef.current?.focus();
	}, []);

	useEffect(() => {
		if (!menuOpen) return;
		const handleKeyDown = (e) => {
			if (e.key === 'Escape') {
				closeMenu();
				e.preventDefault();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [menuOpen, closeMenu]);

	useEffect(() => {
		if (!menuOpen) return;
		function handleClickOutside(e) {
			if (menuRef.current && !menuRef.current.contains(e.target)) {
				closeMenu();
			}
		}
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [menuOpen, closeMenu]);

	useEffect(() => {
		if (menuOpen) {
			const firstFocusable = menuRef.current?.querySelector('a, button, [tabindex]:not([tabindex="-1"])');
			setTimeout(() => firstFocusable?.focus(), 50);
		}
	}, [menuOpen]);

	return (
		<header
			className={`fixed top-0 left-0 right-0 flex justify-center py-4 px-4 md:px-0 z-[100] transition-all duration-300 ${
				scrolled ? "bg-white/10 backdrop-blur-xl py-3" : "bg-transparent"
			}`}
			role="banner"
		>
			<motion.nav
				initial={{ y: -40, opacity: 0 }}
				animate={{ y: 0, opacity: 1 }}
				transition={{ duration: 0.6, ease: "easeOut" }}
				className={`flex items-center justify-between w-full md:w-[90%] lg:w-[85%] max-w-6xl
        ${scrolled ? "bg-white/90" : "bg-white/80"} backdrop-blur-lg border border-gray-200/50 rounded-full py-2.5 px-6 md:px-10 shadow-lg shadow-black/5 z-10 transition-all duration-300`}
				aria-label="Main navigation"
			>
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

				<div className="hidden md:flex items-center space-x-8 text-sm font-semibold text-gray-600">
					<Link
						href="/#howitworks"
						className="hover:text-stellar-blue transition-all duration-200 focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
					>
						How It Works
					</Link>
					<Link
						href="/marketplace"
						className="hover:text-stellar-blue transition-all duration-200 focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
					>
						Marketplace
					</Link>
					<Link
						href="https://edu-vault.gitbook.io/edu-vault-docs/"
						target="_blank"
						className="hover:text-stellar-blue transition-all duration-200 focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
					>
						Docs
					</Link>
				</div>

				<div className="flex items-center gap-4">
					<NotificationCenter />
					<button
						onClick={() => setIsCartOpen(true)}
						className="relative p-2.5 bg-gray-150/40 hover:bg-gray-200/60 active:scale-95 rounded-full text-gray-700 hover:text-stellar-blue transition-all cursor-pointer flex items-center justify-center shrink-0 border border-gray-200/20 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
						aria-label={`Shopping cart${cartItems.length > 0 ? `, ${cartItems.length} items` : ""}`}
					>
						<FaShoppingCart className="w-4 h-4" aria-hidden="true" />
						{cartItems.length > 0 && (
							<span className="absolute -top-1 -right-1.5 bg-stellar-blue text-white font-extrabold text-[9px] w-4.5 h-4.5 rounded-full flex items-center justify-center border border-white" aria-hidden="true">
								{cartItems.length}
							</span>
						)}
					</button>

					{isConnected && address ? (
						<div className="hidden md:flex items-center gap-4">
							{balance && (
								<div className="hidden lg:flex flex-col items-end">
									<span className="text-[10px] uppercase tracking-wider text-gray-400 font-bold">Balance</span>
									<span className="text-xs text-gray-900 font-bold" aria-label={`Balance: ${parseFloat(balance).toFixed(2)} ${balanceSymbol}`}>
										{parseFloat(balance).toFixed(2)} {balanceSymbol}
									</span>
								</div>
							)}

							<div className="relative group" ref={walletDropdownRef}>
								<button
									onClick={() => router.push("/dashboard")}
									className="flex items-center gap-2 bg-stellar-dark text-white hover:bg-stellar-dark/90 text-sm font-bold py-2.5 px-5 rounded-full transition-all duration-300 shadow-md shadow-stellar-dark/10 focus-visible:ring-2 focus-visible:ring-stellar-dark focus-visible:outline-none"
									aria-haspopup="true"
									aria-expanded={false}
								>
									<div className="w-2 h-2 bg-green-400 rounded-full animate-pulse motion-reduce:animate-none" aria-hidden="true"></div>
									{formatAddress(address)}
								</button>

								<div
									className="absolute right-0 mt-3 w-48 bg-white rounded-2xl shadow-xl border border-gray-100 opacity-0 invisible group-focus-within:opacity-100 group-focus-within:visible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50 p-2 overflow-hidden"
									role="menu"
									aria-label="Wallet options"
								>
									<div className="px-4 py-2 border-b border-gray-100 mb-1">
										<span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Network</span>
										<div className="flex items-center gap-1.5 mt-0.5">
											<div className="w-1.5 h-1.5 bg-green-500 rounded-full" aria-hidden="true"></div>
											<span className="text-sm font-semibold text-gray-800">Testnet</span>
										</div>
									</div>
									<button
										onClick={handleCopy}
										className="flex items-center justify-between w-full text-left px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 rounded-xl transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
										role="menuitem"
									>
										Copy Address
										{copied ? <FaCheck className="text-green-500" size={12} aria-hidden="true" /> : <FaCopy className="text-gray-400" size={12} aria-hidden="true" />}
									</button>
									<Link
										href="/dashboard"
										className="flex items-center px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 rounded-xl transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
										role="menuitem"
									>
										Dashboard
									</Link>
									<a
										href={getExplorerAccountUrl(address)}
										target="_blank"
										rel="noopener noreferrer"
										className="flex items-center px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 rounded-xl transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
										role="menuitem"
									>
										View on Explorer <FaExternalLinkAlt className="ml-1" size={10} aria-hidden="true" />
									</a>
									<button
										onClick={disconnect}
										className="flex items-center w-full text-left px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 rounded-xl transition-colors mt-1 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-500"
										role="menuitem"
									>
										Disconnect
									</button>
								</div>
							</div>
						</div>
					) : (
						<WalletButton />
					)}

					<button
						ref={menuButtonRef}
						className="md:hidden flex flex-col space-y-1.5 p-2 focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
						onClick={() => setMenuOpen(!menuOpen)}
						aria-label={menuOpen ? "Close menu" : "Open menu"}
						aria-expanded={menuOpen}
					>
						<span className={`w-5 h-0.5 bg-stellar-dark transition-transform motion-reduce:transition-none ${menuOpen ? "rotate-45 translate-y-2" : ""}`} aria-hidden="true"></span>
						<span className={`w-5 h-0.5 bg-stellar-dark transition-opacity motion-reduce:transition-none ${menuOpen ? "opacity-0" : ""}`} aria-hidden="true"></span>
						<span className={`w-5 h-0.5 bg-stellar-dark transition-transform motion-reduce:transition-none ${menuOpen ? "-rotate-45 -translate-y-2" : ""}`} aria-hidden="true"></span>
					</button>
				</div>

				{menuOpen && (
					<motion.div
						ref={menuRef}
						initial={{ opacity: 0, scale: 0.95 }}
						animate={{ opacity: 1, scale: 1 }}
						className="absolute top-full left-0 right-0 mt-4 mx-4 bg-white border border-gray-100 rounded-3xl shadow-2xl flex flex-col items-center space-y-4 py-8 text-gray-700 md:hidden z-50"
						role="menu"
						aria-label="Mobile navigation menu"
					>
						<Link href="/#howitworks" onClick={closeMenu} className="text-lg font-bold focus-visible:ring-2 focus-visible:ring-blue-500 rounded" role="menuitem">How It Works</Link>
						<Link href="/marketplace" onClick={closeMenu} className="text-lg font-bold focus-visible:ring-2 focus-visible:ring-blue-500 rounded" role="menuitem">Marketplace</Link>
						<Link href="https://edu-vault.gitbook.io/edu-vault-docs/" onClick={closeMenu} className="text-lg font-bold focus-visible:ring-2 focus-visible:ring-blue-500 rounded" role="menuitem">Docs</Link>

						<div className="w-full px-8 pt-4">
							<div className="flex justify-center mb-4">
								<ThemeToggle />
							</div>
							{isConnected && address ? (
								<div className="flex flex-col items-center gap-4 w-full">
									<div className="flex items-center gap-2 text-sm font-bold text-stellar-dark bg-gray-100 px-4 py-2 rounded-full">
										<div className="w-2 h-2 bg-green-500 rounded-full" aria-hidden="true"></div>
										{formatAddress(address)}
									</div>
									{balance && (
										<p className="text-xs text-gray-500">
											{parseFloat(balance).toFixed(2)} {balanceSymbol}
										</p>
									)}
									<div className="flex gap-2 w-full flex-col">
										<button
											onClick={handleCopy}
											className="flex items-center justify-center gap-2 flex-1 bg-gray-50 hover:bg-gray-100 text-gray-700 text-sm font-bold py-3 px-4 rounded-2xl transition-colors focus-visible:ring-2 focus-visible:ring-blue-500"
											role="menuitem"
										>
											{copied ? (
												<><FaCheck className="text-green-500" size={12} aria-hidden="true" /> Copied!</>
											) : (
												<><FaCopy className="text-gray-500" size={12} aria-hidden="true" /> Copy Address</>
											)}
										</button>
										<div className="flex gap-2 w-full">
											<Link
												href="/dashboard"
												onClick={closeMenu}
												className="flex-1 bg-stellar-dark text-white text-sm font-bold py-3 px-4 rounded-2xl text-center focus-visible:ring-2 focus-visible:ring-stellar-dark"
												role="menuitem"
											>
												Dashboard
											</Link>
											<button
												onClick={() => {
													closeMenu();
													disconnect();
												}}
												className="flex-1 bg-red-50 text-red-600 text-sm font-bold py-3 px-4 rounded-2xl focus-visible:ring-2 focus-visible:ring-red-500"
												role="menuitem"
											>
												Log Out
											</button>
										</div>
									</div>
								</div>
							) : (
								<div className="flex justify-center w-full">
									<WalletButton />
								</div>
							)}
						</div>
					</motion.div>
				)}
			</motion.nav>
		</header>
	);
}
