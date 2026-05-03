"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { TrendingUp, DollarSign, Wallet, ArrowUpRight } from "lucide-react";

// ─── Area Chart (pure SVG) ────────────────────────────────────────────────────

function AreaChart({ data }) {
  const W = 800;
  const H = 200;
  const PAD = { top: 16, right: 24, bottom: 32, left: 40 };

  const values = data.map((d) => d.value);
  const max = Math.max(...values, 1); // avoid divide-by-zero on all-zero data
  const min = 0;

  const xStep = (W - PAD.left - PAD.right) / (data.length - 1);
  const yScale = (v) =>
    PAD.top + (H - PAD.top - PAD.bottom) * (1 - (v - min) / (max - min));

  const points = data.map((d, i) => ({
    x: PAD.left + i * xStep,
    y: yScale(d.value),
  }));

  const pathD = points.reduce((acc, pt, i) => {
    if (i === 0) return `M ${pt.x},${pt.y}`;
    const prev = points[i - 1];
    const cpX = (prev.x + pt.x) / 2;
    return `${acc} C ${cpX},${prev.y} ${cpX},${pt.y} ${pt.x},${pt.y}`;
  }, "");

  const areaD = `${pathD} L ${points[points.length - 1].x},${H - PAD.bottom} L ${points[0].x},${H - PAD.bottom} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-48" preserveAspectRatio="none">
      <defs>
        <linearGradient id="blueGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75, 1].map((t) => {
        const y = PAD.top + (H - PAD.top - PAD.bottom) * t;
        return (
          <line key={t} x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke="#e5e7eb" strokeWidth="1" />
        );
      })}
      <path d={areaD} fill="url(#blueGrad)" />
      <path d={pathD} fill="none" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((pt, i) => (
        <circle key={i} cx={pt.x} cy={pt.y} r="4" fill="#3b82f6" />
      ))}
      {data.map((d, i) => (
        <text key={i} x={points[i].x} y={H - PAD.bottom + 18} textAnchor="middle" fontSize="11" fill="#9ca3af">
          {d.day}
        </text>
      ))}
    </svg>
  );
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ title, value, sub, icon: Icon, color }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 flex items-start gap-4">
      <div className={`p-3 rounded-xl ${color}`}>
        <Icon size={20} className="text-white" />
      </div>
      <div className="flex-1">
        <p className="text-sm text-gray-500 mb-1">{title}</p>
        <p className="text-2xl font-bold text-gray-900">{value}</p>
        {sub && (
          <p className="text-xs text-emerald-600 flex items-center gap-1 mt-1">
            <ArrowUpRight size={12} />
            {sub}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Skeleton loader ──────────────────────────────────────────────────────────

function Skeleton({ className }) {
  return <div className={`animate-pulse bg-gray-100 rounded-lg ${className}`} />;
}

// ─── Default / empty state data ───────────────────────────────────────────────

const EMPTY_CHART = [
  { day: "Mon", value: 0 },
  { day: "Tue", value: 0 },
  { day: "Wed", value: 0 },
  { day: "Thu", value: 0 },
  { day: "Fri", value: 0 },
  { day: "Sat", value: 0 },
  { day: "Sun", value: 0 },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchAnalytics() {
      try {
        const res = await fetch("/api/creator/analytics");
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        setData(await res.json());
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchAnalytics();
  }, []);

  const totalRevenue = data ? `$${Number(data.totalRevenue).toFixed(2)}` : "$0.00";
  const monthlySales = data ? String(data.monthlySales) : "0";
  const chartData = data?.chartData?.length ? data.chartData : EMPTY_CHART;
  const topMaterials = data?.topMaterials ?? [];
  const withdrawals = data?.withdrawals ?? [];

  return (
    <div className="space-y-8">
      {/* Page title */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Creator Analytics</h1>
        <p className="text-sm text-gray-500 mt-1">
          Track your earnings, sales, and material performance.
        </p>
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
          {error}
        </div>
      )}

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        {loading ? (
          <>
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </>
        ) : (
          <>
            <StatCard
              title="Total Revenue"
              value={totalRevenue}
              sub="All-time confirmed sales"
              icon={DollarSign}
              color="bg-blue-500"
            />
            <StatCard
              title="Monthly Sales"
              value={monthlySales}
              sub="Purchases in last 30 days"
              icon={TrendingUp}
              color="bg-violet-500"
            />
            <StatCard
              title="Available Balance"
              value={totalRevenue}
              sub="Based on confirmed revenue"
              icon={Wallet}
              color="bg-emerald-500"
            />
          </>
        )}
      </div>

      {/* Area Chart */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
        <h2 className="text-base font-semibold text-gray-800 mb-4">
          Revenue — Last 7 Days
        </h2>
        {loading ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <AreaChart data={chartData} />
        )}
      </div>

      {/* Tables row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Performing Materials */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-base font-semibold text-gray-800 mb-4">
            Top Performing Materials
          </h2>
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : topMaterials.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">No sales yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-100">
                  <th className="pb-3 font-medium">Material</th>
                  <th className="pb-3 font-medium text-right">Sales</th>
                  <th className="pb-3 font-medium text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {topMaterials.map((m, i) => (
                  <tr key={i} className="border-b border-gray-50 last:border-0 hover:bg-gray-50 transition-colors">
                    <td className="py-3 text-gray-700 font-medium truncate max-w-[160px]">{m.name}</td>
                    <td className="py-3 text-right text-gray-600">{m.sales}</td>
                    <td className="py-3 text-right text-blue-600 font-semibold">{m.revenue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Withdrawal History */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-base font-semibold text-gray-800 mb-4">
            Withdrawal History
          </h2>
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : withdrawals.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">No withdrawals yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-100">
                  <th className="pb-3 font-medium">Date</th>
                  <th className="pb-3 font-medium text-right">Amount</th>
                  <th className="pb-3 font-medium text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {withdrawals.map((w, i) => (
                  <tr key={i} className="border-b border-gray-50 last:border-0 hover:bg-gray-50 transition-colors">
                    <td className="py-3 text-gray-600">{w.date}</td>
                    <td className="py-3 text-right text-gray-700 font-medium">{w.amount}</td>
                    <td className="py-3 text-right">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          w.status === "Success"
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-amber-50 text-amber-700"
                        }`}
                      >
                        {w.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
