"use client";
import { FaArrowUp, FaArrowDown } from "react-icons/fa";
import { useDashboardStats } from "@/hooks/api/useProfile";
import { QueryStateProvider } from "@/components/common/QueryStateProvider";
import { StatCardSkeleton } from "@/components/common/DataSkeleton";

export default function EarningsSection() {
	const statsQuery = useDashboardStats();

	return (
		<QueryStateProvider 
			query={statsQuery}
			loadingComponent={
				<div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
					{[1, 2, 3, 4].map(i => <StatCardSkeleton key={i} />)}
				</div>
			}
			renderData={(stats) => (
				<div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
					{stats.map((item, index) => (
						<div
							key={index}
							className="bg-white border border-gray-100 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow"
						>
							<div className="flex justify-between items-center mb-3">
								<h3 className="text-sm font-medium text-gray-500">{item.label}</h3>
								<div className={`p-1.5 rounded-full ${item.change.startsWith("+") ? 'bg-green-50' : 'bg-red-50'}`}>
									{item.change.startsWith("+") ? (
										<FaArrowUp className={`w-3 h-3 ${item.change.startsWith("+") ? 'text-green-600' : 'text-red-600'}`} />
									) : (
										<FaArrowDown className={`w-3 h-3 ${item.change.startsWith("+") ? 'text-green-600' : 'text-red-600'}`} />
									)}
								</div>
							</div>
							<div className="text-2xl font-bold mb-1">{item.value}</div>
							<p className={`text-xs font-medium ${item.change.startsWith("+") ? 'text-green-600' : 'text-red-600'}`}>{item.change} from last month</p>
						</div>
					))}
				</div>
			)}
		/>
	);
}

