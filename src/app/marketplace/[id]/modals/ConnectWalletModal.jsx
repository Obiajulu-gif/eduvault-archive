"use client";
import { motion, AnimatePresence } from "framer-motion";
import { FaTimes } from "react-icons/fa";
import Image from "next/image";
import useFocusTrap from "@/hooks/useFocusTrap";

export default function ConnectWalletModal({ isOpen, onClose }) {
	const modalRef = useFocusTrap(isOpen, onClose);

	const wallets = [
		{
			name: "MetaMask",
			icon: "/images/metamask.png",
		},
		{
			name: "Phantom",
			icon: "/images/phantom.png",
		},
		{
			name: "Coinbase Wallet",
			icon: "/images/coinbase.png",
		},
		{
			name: "Other Wallets",
			icon: "/images/walletconnect.png",
		},
	];

	return (
		<AnimatePresence>
			{isOpen && (
				<>
					<motion.div
						initial={{ opacity: 0 }}
						animate={{ opacity: 0.5 }}
						exit={{ opacity: 0 }}
						className="fixed inset-0 bg-black backdrop-blur-sm z-40"
						onClick={onClose}
					/>

					<motion.div
						ref={modalRef}
						role="dialog"
						aria-modal="true"
						aria-labelledby="connect-wallet-title"
						initial={{ opacity: 0, scale: 0.9, y: 50 }}
						animate={{ opacity: 1, scale: 1, y: 0 }}
						exit={{ opacity: 0, scale: 0.9, y: 50 }}
						className="fixed inset-0 flex items-center justify-center z-50"
					>
						<div className="bg-white rounded-2xl shadow-lg w-[90%] max-w-sm p-6 relative">
							{/* Close Button */}
							<button
								onClick={onClose}
								className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none rounded-md"
								aria-label="Close connect wallet modal"
							>
								<FaTimes />
							</button>

							{/* Header */}
							<h2 id="connect-wallet-title" className="text-lg font-bold text-gray-900 mb-1 text-center">
								Connect Wallet
							</h2>
							<p className="text-sm text-gray-500 mb-6 text-center">
								Get started by connecting your preferred wallet below.
							</p>

							{/* Wallet Options */}
							<div className="space-y-3">
								{wallets.map((wallet, i) => (
									<button
										key={i}
										className="flex justify-between items-center w-full border border-gray-200 hover:border-blue-500 hover:bg-blue-50 transition-all rounded-lg py-2.5 px-4 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
									>
										<div className="flex items-center gap-3">
											<Image
												src={wallet.icon}
												alt=""
												width={26}
												height={26}
											/>
											<span className="font-medium text-sm text-gray-800">
												{wallet.name}
											</span>
										</div>
										<span className="text-gray-400" aria-hidden="true">→</span>
									</button>
								))}
							</div>

							{/* No Wallet Option */}
							<div className="flex items-center gap-2 mt-5 text-xs text-gray-500 justify-center">
								<input
									type="checkbox"
									id="no-wallet-checkbox"
									className="focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
								/>
								<label htmlFor="no-wallet-checkbox">I don’t have a wallet</label>
							</div>
						</div>
					</motion.div>
				</>
			)}
		</AnimatePresence>
	);
}
