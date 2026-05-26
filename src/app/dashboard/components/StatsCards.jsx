"use client";
import { FaArrowUp, FaArrowDown, FaUpload, FaAward } from "react-icons/fa";

export default function StatsCards() {
	const stats = [
		{
			label: "Earnings",
			value: "2.00 XLM",
			change: "+12.3%",
			icon: <FaArrowUp className="text-green-500" />,
		},
		{
			label: "Uploaded Notes",
			value: "7 NOTES",
			change: "+8.1%",
			icon: <FaUpload className="text-blue-500" />,
		},
		{
			label: "Downloads",
			value: "182",
			change: "-5.3%",
			icon: <FaArrowDown className="text-red-500" />,
		},
		{
			label: "Rank",
			value: "#12 UNN",
			change: "+3.2%",
			icon: <FaAward className="text-yellow-500" />,
		},
	];

	return (
		<div className="grid md:grid-cols-4 gap-6 mb-10">
			{stats.map((s, i) => (
				<div
					key={i}
					className="p-6 bg-white border border-gray-200 rounded-xl shadow-sm"
				>
					<div className="flex justify-between mb-2">
						<h3 className="text-sm text-gray-500">{s.label}</h3>
						{s.icon}
					</div>
					<div className="text-2xl font-bold mb-1">{s.value}</div>
					<div
						className={`text-sm font-medium ${
							s.change.startsWith("-") ? "text-red-500" : "text-green-500"
						}`}
					>
						{s.change}
					</div>
				</div>
			))}
		</div>
	);
}
