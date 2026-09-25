"use client";

import { useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
} from "recharts";

const data7Days = [
  { name: "Mon", revenue: 120, sales: 5 },
  { name: "Tue", revenue: 200, sales: 8 },
  { name: "Wed", revenue: 150, sales: 6 },
  { name: "Thu", revenue: 300, sales: 12 },
  { name: "Fri", revenue: 250, sales: 10 },
  { name: "Sat", revenue: 400, sales: 15 },
  { name: "Sun", revenue: 350, sales: 14 },
];

const data30Days = [
  { name: "Week 1", revenue: 800, sales: 30 },
  { name: "Week 2", revenue: 1200, sales: 45 },
  { name: "Week 3", revenue: 1500, sales: 55 },
  { name: "Week 4", revenue: 2100, sales: 80 },
];

const dataAllTime = [
  { name: "Jan", revenue: 3000, sales: 120 },
  { name: "Feb", revenue: 4500, sales: 160 },
  { name: "Mar", revenue: 3800, sales: 140 },
  { name: "Apr", revenue: 5200, sales: 200 },
  { name: "May", revenue: 6000, sales: 230 },
  { name: "Jun", revenue: 7500, sales: 280 },
];

export default function RevenueChart() {
  const [timeRange, setTimeRange] = useState("30");
  const [chartType, setChartType] = useState("area");

  const getData = () => {
    switch (timeRange) {
      case "7":
        return data7Days;
      case "30":
        return data30Days;
      case "all":
        return dataAllTime;
      default:
        return data30Days;
    }
  };

  const chartData = getData();

  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-gray-900/90 border border-gray-700/50 backdrop-blur-md p-4 rounded-xl shadow-xl">
          <p className="text-gray-300 font-medium mb-1">{label}</p>
          <p className="text-emerald-400 font-bold text-lg">
            ${payload[0].value}
          </p>
          {payload[1] && (
            <p className="text-blue-400 text-sm mt-1">
              {payload[1].value} Sales
            </p>
          )}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="bg-gray-900/40 border border-gray-800/50 backdrop-blur-sm rounded-2xl p-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
        <div>
          <h2 className="text-xl font-bold text-white">Revenue Performance</h2>
          <p className="text-gray-400 text-sm mt-1">
            Track your earnings and sales over time
          </p>
        </div>
        
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex bg-gray-800/50 rounded-lg p-1 border border-gray-700/50">
            <button
              onClick={() => setChartType("area")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                chartType === "area"
                  ? "bg-gray-700 text-white"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              Area
            </button>
            <button
              onClick={() => setChartType("bar")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                chartType === "bar"
                  ? "bg-gray-700 text-white"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              Bar
            </button>
          </div>

          <div className="flex bg-gray-800/50 rounded-lg p-1 border border-gray-700/50">
            <button
              onClick={() => setTimeRange("7")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                timeRange === "7"
                  ? "bg-emerald-500/20 text-emerald-400"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              7D
            </button>
            <button
              onClick={() => setTimeRange("30")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                timeRange === "30"
                  ? "bg-emerald-500/20 text-emerald-400"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              30D
            </button>
            <button
              onClick={() => setTimeRange("all")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                timeRange === "all"
                  ? "bg-emerald-500/20 text-emerald-400"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              All Time
            </button>
          </div>
        </div>
      </div>

      <div className="h-[350px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          {chartType === "area" ? (
            <AreaChart
              data={chartData}
              margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
            >
              <defs>
                <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
              <XAxis 
                dataKey="name" 
                stroke="#6b7280" 
                fontSize={12} 
                tickLine={false} 
                axisLine={false}
              />
              <YAxis 
                stroke="#6b7280" 
                fontSize={12} 
                tickLine={false} 
                axisLine={false} 
                tickFormatter={(value) => `$${value}`}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="revenue"
                stroke="#10b981"
                strokeWidth={3}
                fillOpacity={1}
                fill="url(#colorRevenue)"
              />
            </AreaChart>
          ) : (
            <BarChart
              data={chartData}
              margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              barSize={32}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
              <XAxis 
                dataKey="name" 
                stroke="#6b7280" 
                fontSize={12} 
                tickLine={false} 
                axisLine={false}
              />
              <YAxis 
                stroke="#6b7280" 
                fontSize={12} 
                tickLine={false} 
                axisLine={false} 
                tickFormatter={(value) => `$${value}`}
              />
              <Tooltip content={<CustomTooltip />} />
              <Bar 
                dataKey="revenue" 
                fill="#10b981" 
                radius={[4, 4, 0, 0]} 
              />
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
