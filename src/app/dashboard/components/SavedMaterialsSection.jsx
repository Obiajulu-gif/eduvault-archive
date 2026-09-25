"use client";

import Link from "next/link";
import { FaBookmark, FaHeart, FaRegHeart } from "react-icons/fa";
import SaveMaterialButton from "@/components/materials/SaveMaterialButton";
import { useSavedMaterials } from "@/hooks/api/useSavedMaterials";
import { useWallet } from "@/hooks/useWallet";

export default function SavedMaterialsSection() {
	const { isConnected, connect, state } = useWallet();
	const { items, isLoading } = useSavedMaterials();

	return (
		<section className="p-6 bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl shadow-sm">
			<div className="flex items-center justify-between mb-6">
				<div>
					<h3 className="font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
						<FaBookmark className="text-indigo-500" /> Saved Materials
					</h3>
					<p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Bookmark notes to compare and revisit later.</p>
				</div>
				<Link href="/marketplace" className="text-indigo-600 hover:text-indigo-700 font-medium text-sm">
					Browse
				</Link>
			</div>

			{!isConnected ? (
				<div className="rounded-xl border border-dashed border-indigo-200 dark:border-indigo-800 bg-indigo-50/60 dark:bg-indigo-950/30 p-6 text-center">
					<FaRegHeart className="mx-auto mb-3 text-2xl text-indigo-400" />
					<h4 className="font-semibold text-gray-900 dark:text-gray-100">Connect your wallet to view saved materials</h4>
					<p className="text-sm text-gray-600 dark:text-gray-400 mt-2">Your wishlist is tied to your wallet so it stays separate from other buyers.</p>
					<button
						type="button"
						onClick={connect}
						disabled={state.status === "connecting" || state.status === "initializing"}
						className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-60"
					>
						{state.status === "connecting" ? "Connecting..." : "Connect wallet"}
					</button>
				</div>
			) : isLoading ? (
				<div className="grid sm:grid-cols-2 gap-4">
					{[1, 2].map((item) => (
						<div key={item} className="h-32 rounded-xl bg-gray-100 dark:bg-gray-800 animate-pulse" />
					))}
				</div>
			) : items.length === 0 ? (
				<div className="rounded-xl border border-dashed border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-6 text-center">
					<FaHeart className="mx-auto mb-3 text-2xl text-rose-300" />
					<h4 className="font-semibold text-gray-900 dark:text-gray-100">No saved materials yet</h4>
					<p className="text-sm text-gray-600 dark:text-gray-400 mt-2">Tap the heart on any marketplace card or material detail page to save it here.</p>
				</div>
			) : (
				<div className="grid sm:grid-cols-2 gap-4">
					{items.slice(0, 4).map((material) => (
						<div key={material.id || material._id} className="relative rounded-xl border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-4 pr-14 hover:border-indigo-200 dark:hover:border-indigo-700 transition">
							<SaveMaterialButton material={material} />
							<Link href={`/marketplace/${material._id || material.id}`} className="block">
								<h4 className="font-semibold text-sm text-gray-900 dark:text-gray-100 line-clamp-1 hover:text-indigo-600">{material.title}</h4>
								<p className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">{material.description}</p>
								<div className="flex items-center justify-between mt-4 text-xs">
									<span className="text-gray-500 dark:text-gray-400">{material.subject || material.category || "Material"}</span>
									<span className="font-bold text-green-600">{material.price} {material.currency || "XLM"}</span>
								</div>
							</Link>
						</div>
					))}
				</div>
			)}
		</section>
	);
}
