"use client";
import Image from "next/image";
import { FaHeart } from "react-icons/fa";
import { useTrendingMaterials } from "@/hooks/api/useMaterials";
import { QueryStateProvider } from "@/components/common/QueryStateProvider";
import Link from "next/link";

export default function TrendingMaterials() {
	const materialsQuery = useTrendingMaterials({ pageSize: 3 });

	return (
		<div className="p-6 bg-white border border-gray-100 rounded-xl shadow-sm">
			<div className="flex justify-between items-center mb-6">
				<h3 className="font-bold text-gray-900">Trending Materials</h3>
				<Link href="/marketplace" className="text-indigo-600 hover:text-indigo-700 font-medium text-sm">
					See All
				</Link>
			</div>
			
			<QueryStateProvider 
				query={materialsQuery}
				loadingComponent={
					<div className="space-y-4">
						{[1, 2, 3].map(i => (
							<div key={i} className="flex gap-4 items-start">
								<div className="w-16 h-20 bg-gray-100 rounded-md animate-pulse" />
								<div className="flex-1 space-y-2">
									<div className="h-3 bg-gray-100 rounded w-full animate-pulse" />
									<div className="h-2 bg-gray-100 rounded w-1/2 animate-pulse" />
								</div>
							</div>
						))}
					</div>
				}
				renderData={(data) => (
					<div className="space-y-4">
						{data.items?.slice(0, 3).map((item, i) => (
							<Link
								href={`/marketplace/${item._id}`}
								key={item._id || i}
								className="flex gap-4 items-start group hover:bg-gray-50 p-2 -mx-2 rounded-lg transition-colors cursor-pointer block"
							>
								<div className="w-16 h-20 bg-gradient-to-br from-indigo-100 to-blue-50 rounded-md flex flex-col items-center justify-center border border-indigo-100/50 flex-shrink-0 overflow-hidden relative">
									{item.image || item.thumbnail ? (
										<Image
											src={item.image || item.thumbnail}
											alt={item.title}
											fill
											className="object-cover"
										/>
									) : (
										<span className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider">Note</span>
									)}
								</div>
								<div className="flex-1 min-w-0 py-1">
									<h4 className="font-semibold text-sm text-gray-900 truncate mb-1">{item.title}</h4>
									<p className="text-xs text-gray-500 mb-2 truncate">by {item.author || item.creator || "Anonymous"}</p>
									<div className="flex justify-between items-center text-xs">
										<span className="flex items-center text-gray-500 gap-1">
											<FaHeart className="w-3 h-3 text-rose-400" />
											{item.likes || 0}
										</span>
										<span className="font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded-full">
											{item.price} {item.currency || "XLM"}
										</span>
									</div>
								</div>
							</Link>
						))}
					</div>
				)}
			/>
		</div>
	);
}

