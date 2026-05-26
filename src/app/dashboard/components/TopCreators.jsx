"use client";
import Link from "next/link";
import { FaMedal } from "react-icons/fa";
import { useTopCreators } from "@/hooks/api/useProfile";
import { QueryStateProvider } from "@/components/common/QueryStateProvider";
import { CreatorItemSkeleton } from "@/components/common/DataSkeleton";

export default function TopCreators() {
	const creatorsQuery = useTopCreators();

	return (
		<div className="p-6 bg-white border border-gray-100 rounded-xl shadow-sm">
			<div className="flex justify-between items-center mb-6">
				<h3 className="font-bold text-gray-900">Top Creators</h3>
				<button className="text-indigo-600 hover:text-indigo-700 font-medium text-sm">
					See All
				</button>
			</div>
			
			<QueryStateProvider 
				query={creatorsQuery}
				loadingComponent={
					<div className="space-y-4">
						{[1, 2, 3, 4, 5].map(i => <CreatorItemSkeleton key={i} />)}
					</div>
				}
				renderData={(creators) => (
					<div className="space-y-4">
						{creators.map((c, i) => (
							<Link
								key={i}
								href={`/creator/${c.name.toLowerCase().replace(" ", "-")}`}
								className="flex justify-between items-center hover:bg-gray-50 p-2 -mx-2 rounded-lg transition-colors group"
							>
								<div className="flex items-center gap-3">
									<div className="relative">
										<div className="w-10 h-10 bg-gradient-to-r from-blue-100 to-indigo-100 rounded-full flex items-center justify-center text-indigo-700 font-bold text-sm">
											{c.name.charAt(0)}
										</div>
										{i < 3 && (
											<div className="absolute -bottom-1 -right-1 bg-white rounded-full p-0.5">
												<FaMedal className={`w-3.5 h-3.5 ${i === 0 ? 'text-yellow-400' : i === 1 ? 'text-gray-400' : 'text-amber-600'}`} />
											</div>
										)}
									</div>
									<div>
										<span className="text-sm font-semibold text-gray-900 block group-hover:text-indigo-600 transition-colors">{c.name}</span>
										<span className="text-xs text-gray-500">{c.revenue}</span>
									</div>
								</div>
								<span
									className={`px-2.5 py-1 text-[10px] rounded-full font-bold uppercase tracking-wider ${
										i === 0 ? "bg-indigo-600 text-white shadow-sm" : "bg-gray-100 text-gray-600"
									}`}
								>
									#{c.rank || i + 1}
								</span>
							</Link>
						))}
					</div>
				)}
			/>
		</div>
	);
}

