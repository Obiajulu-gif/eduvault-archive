"use client";

import { useEffect, useState } from "react";
import { FaTicketAlt } from "react-icons/fa";
import CouponForm from "@/components/CouponForm";

function formatDate(value) { return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
function status(coupon) { return new Date(coupon.expiresAt) <= new Date() ? "Expired" : "Active"; }

export default function CouponsPage() {
  const [coupons, setCoupons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => { fetch("/api/creator/coupons").then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || "Unable to load coupons."); setCoupons(data.coupons); }).catch((err) => setError(err.message)).finally(() => setLoading(false)); }, []);
  return <section className="space-y-8"><div><p className="text-sm font-semibold text-blue-600">Creator tools</p><h1 className="mt-1 text-3xl font-bold text-gray-950">Coupon codes</h1><p className="mt-2 text-gray-600">Create campaign discounts and monitor their availability.</p></div><CouponForm onCreated={(coupon) => setCoupons((current) => [coupon, ...current])} />
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm"><div className="flex items-center justify-between border-b border-gray-100 p-6"><h2 className="font-semibold text-gray-900">Your coupons</h2><span className="text-sm text-gray-500">{coupons.length} total</span></div>{loading ? <p className="p-6 text-sm text-gray-500">Loading coupons…</p> : error ? <p className="p-6 text-sm text-red-600">{error}</p> : coupons.length === 0 ? <div className="p-10 text-center text-gray-500"><FaTicketAlt className="mx-auto mb-3 text-3xl text-gray-300" /><p className="font-medium text-gray-700">No coupons yet</p><p className="mt-1 text-sm">Your new campaign codes will appear here.</p></div> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500"><tr><th className="px-6 py-3">Code</th><th className="px-6 py-3">Discount</th><th className="px-6 py-3">Redemptions</th><th className="px-6 py-3">Expires</th><th className="px-6 py-3">Status</th></tr></thead><tbody>{coupons.map((coupon) => { const currentStatus = status(coupon); return <tr key={coupon.id || coupon._id} className="border-t border-gray-100 text-gray-700"><td className="px-6 py-4 font-semibold text-gray-900">{coupon.code}</td><td className="px-6 py-4">{coupon.discountPercent}%</td><td className="px-6 py-4">{coupon.redemptions || 0} / {coupon.maxRedemptions}</td><td className="px-6 py-4">{formatDate(coupon.expiresAt)}</td><td className="px-6 py-4"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${currentStatus === "Active" ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-600"}`}>{currentStatus}</span></td></tr>; })}</tbody></table></div>}</div></section>;
}
