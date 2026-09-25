"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  FaBook,
  FaSearch,
  FaClock,
  FaStar,
  FaArrowRight,
  FaBell,
  FaBookmark,
  FaGraduationCap,
  FaChartLine,
  FaShoppingBag,
  FaHeart,
  FaFire,
} from "react-icons/fa";
import { useMarketplaceMaterials } from "@/hooks/api/useMaterials";
import { useSavedMaterials } from "@/hooks/api/useSavedMaterials";
import { usePurchaseHistory } from "@/hooks/api/usePurchases";

function getPreviewImage(material) {
  return (
    material.coverImageUrl ||
    material.thumbnailUrl ||
    material.image ||
    "/images/image1.jpg"
  );
}

export default function LearnerDashboardPage() {
  const { data: marketData, isLoading: marketLoading } = useMarketplaceMaterials({
    pageSize: 8,
    sortBy: "popular",
  });
  const { items: savedItems, isLoading: savedLoading } = useSavedMaterials();
  const { data: purchaseData, isLoading: purchasesLoading } = usePurchaseHistory();

  const recentMaterials = marketData?.items || [];
  const savedMaterials = savedItems || [];
  const purchases = purchaseData?.purchases || purchaseData || [];

  const notifications = [
    { id: 1, text: "New materials added in Science this week", time: "2h ago", type: "new" },
    { id: 2, text: "Your saved material \"Intro to Soroban\" got a price drop", time: "5h ago", type: "deal" },
    { id: 3, text: "3 new reviews on materials you purchased", time: "1d ago", type: "review" },
  ];

  const quickActions = [
    { label: "Browse Marketplace", href: "/marketplace", icon: <FaShoppingBag className="w-5 h-5" />, color: "blue" },
    { label: "My Library", href: "/dashboard/library", icon: <FaBook className="w-5 h-5" />, color: "emerald" },
    { label: "Saved Materials", href: "/dashboard/favourites", icon: <FaHeart className="w-5 h-5" />, color: "rose" },
    { label: "Learning Progress", href: "/dashboard/analytics", icon: <FaChartLine className="w-5 h-5" />, color: "amber" },
  ];

  return (
    <div className="space-y-8 max-w-7xl mx-auto pb-10">
      {/* Learner Welcome Header */}
      <div className="bg-gradient-to-r from-emerald-600 to-teal-700 rounded-xl p-6 md:p-8 overflow-hidden relative shadow-sm">
        <div className="relative z-10 max-w-[75%]">
          <h1 className="text-2xl md:text-3xl font-bold text-white mb-2">
            Learner Hub
          </h1>
          <p className="text-emerald-100 text-sm md:text-base mb-5 leading-relaxed">
            Track your progress, discover new resources, and continue your learning journey.
          </p>
          <Link
            href="/marketplace"
            className="inline-flex items-center gap-2 bg-white text-emerald-700 px-5 py-2.5 rounded-full hover:bg-emerald-50 shadow-sm font-medium transition text-sm"
          >
            <FaSearch className="w-3.5 h-3.5" />
            Explore Marketplace
          </Link>
        </div>
        <div className="absolute top-0 right-0 -mr-8 -mt-8 w-48 h-48 rounded-full bg-white opacity-10 blur-2xl" />
        <div className="absolute bottom-0 right-16 -mb-8 w-32 h-32 rounded-full bg-white opacity-10 blur-xl" />
      </div>

      {/* Quick Action Shortcuts */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {quickActions.map((action) => (
          <Link
            key={action.label}
            href={action.href}
            className={`bg-white border border-gray-200 rounded-xl p-5 hover:shadow-md hover:border-${action.color}-300 transition-all group flex flex-col items-center text-center gap-3`}
          >
            <div className={`w-12 h-12 rounded-xl bg-${action.color}-50 text-${action.color}-600 flex items-center justify-center group-hover:scale-110 transition-transform`}>
              {action.icon}
            </div>
            <span className="text-sm font-semibold text-gray-700 group-hover:text-gray-900">
              {action.label}
            </span>
          </Link>
        ))}
      </div>

      {/* Main Content Grid */}
      <div className="grid lg:grid-cols-3 gap-8 items-start">
        {/* Left Column (2/3) */}
        <div className="lg:col-span-2 space-y-8">
          {/* Recently Added Resources */}
          <section className="bg-white border border-gray-200 rounded-xl shadow-sm">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <FaFire className="text-orange-500 w-4 h-4" />
                <h2 className="text-base font-bold text-gray-900">Recent Resources</h2>
              </div>
              <Link
                href="/marketplace"
                className="text-xs font-semibold text-blue-600 hover:underline flex items-center gap-1"
              >
                View All <FaArrowRight className="w-3 h-3" />
              </Link>
            </div>

            {marketLoading ? (
              <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="bg-gray-50 rounded-lg h-24 animate-pulse" />
                ))}
              </div>
            ) : recentMaterials.length === 0 ? (
              <div className="p-10 text-center">
                <FaBook className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                <p className="text-sm text-gray-500">No resources available yet.</p>
              </div>
            ) : (
              <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
                {recentMaterials.slice(0, 6).map((material) => {
                  const materialId = material._id || material.id;
                  return (
                    <Link
                      key={materialId}
                      href={`/marketplace/${materialId}`}
                      className="flex gap-3 p-3 rounded-lg border border-gray-100 hover:border-blue-200 hover:bg-blue-50/30 transition-all group"
                    >
                      <div className="relative w-16 h-16 rounded-lg overflow-hidden shrink-0 bg-gray-100">
                        <Image
                          src={getPreviewImage(material)}
                          alt={material.title}
                          fill
                          className="object-cover"
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-semibold text-gray-800 line-clamp-1 group-hover:text-blue-600 transition-colors">
                          {material.title}
                        </h3>
                        <p className="text-[11px] text-gray-400 mt-0.5">
                          {material.subject || "General"} &middot; {material.author || "Anonymous"}
                        </p>
                        <div className="flex items-center gap-2 mt-1.5">
                          <span className="text-xs font-bold text-blue-600">
                            {material.price} XLM
                          </span>
                          <span className="flex items-center gap-0.5 text-[11px] text-gray-400">
                            <FaStar className="text-yellow-400 w-3 h-3" />
                            {material.rating || "4.8"}
                          </span>
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          {/* My Purchases Progress */}
          <section className="bg-white border border-gray-200 rounded-xl shadow-sm">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <FaGraduationCap className="text-emerald-500 w-4 h-4" />
                <h2 className="text-base font-bold text-gray-900">My Purchases</h2>
              </div>
              <Link
                href="/dashboard/library"
                className="text-xs font-semibold text-blue-600 hover:underline flex items-center gap-1"
              >
                View All <FaArrowRight className="w-3 h-3" />
              </Link>
            </div>

            {purchasesLoading ? (
              <div className="p-5 space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="bg-gray-50 rounded-lg h-14 animate-pulse" />
                ))}
              </div>
            ) : (Array.isArray(purchases) ? purchases : []).length === 0 ? (
              <div className="p-10 text-center">
                <FaShoppingBag className="w-8 h-8 text-gray-300 mx-auto mb-3" />
                <p className="text-sm text-gray-500 mb-3">You haven&apos;t purchased any materials yet.</p>
                <Link
                  href="/marketplace"
                  className="text-sm font-semibold text-blue-600 hover:underline"
                >
                  Browse the Marketplace
                </Link>
              </div>
            ) : (
              <div className="p-5 space-y-3">
                {(Array.isArray(purchases) ? purchases : []).slice(0, 5).map((purchase, idx) => (
                  <div
                    key={purchase._id || idx}
                    className="flex items-center justify-between p-3 rounded-lg border border-gray-100 hover:bg-gray-50 transition"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                        <FaBook className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-800 truncate">
                          {purchase.title || purchase.materialTitle || "Purchased Material"}
                        </p>
                        <p className="text-[11px] text-gray-400">
                          {purchase.subject || "Study Resource"}
                        </p>
                      </div>
                    </div>
                    <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded-md shrink-0">
                      Owned
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Right Column (1/3) */}
        <div className="space-y-8">
          {/* Notifications */}
          <section className="bg-white border border-gray-200 rounded-xl shadow-sm">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <FaBell className="text-blue-500 w-4 h-4" />
                <h2 className="text-base font-bold text-gray-900">Notifications</h2>
              </div>
              <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                {notifications.length} new
              </span>
            </div>
            <div className="p-4 space-y-3">
              {notifications.map((notif) => (
                <div
                  key={notif.id}
                  className="flex items-start gap-3 p-3 rounded-lg hover:bg-gray-50 transition"
                >
                  <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${
                    notif.type === "new" ? "bg-blue-500" :
                    notif.type === "deal" ? "bg-emerald-500" : "bg-amber-500"
                  }`} />
                  <div className="min-w-0">
                    <p className="text-xs text-gray-700 leading-relaxed">
                      {notif.text}
                    </p>
                    <p className="text-[10px] text-gray-400 mt-1 flex items-center gap-1">
                      <FaClock className="w-2.5 h-2.5" />
                      {notif.time}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Saved Materials */}
          <section className="bg-white border border-gray-200 rounded-xl shadow-sm">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <FaBookmark className="text-rose-500 w-4 h-4" />
                <h2 className="text-base font-bold text-gray-900">Saved Materials</h2>
              </div>
              <Link
                href="/dashboard/favourites"
                className="text-xs font-semibold text-blue-600 hover:underline flex items-center gap-1"
              >
                View All <FaArrowRight className="w-3 h-3" />
              </Link>
            </div>

            {savedLoading ? (
              <div className="p-5 space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="bg-gray-50 rounded-lg h-12 animate-pulse" />
                ))}
              </div>
            ) : (Array.isArray(savedMaterials) ? savedMaterials : []).length === 0 ? (
              <div className="p-8 text-center">
                <FaHeart className="w-6 h-6 text-gray-300 mx-auto mb-2" />
                <p className="text-xs text-gray-500">No saved materials yet.</p>
              </div>
            ) : (
              <div className="p-4 space-y-2">
                {(Array.isArray(savedMaterials) ? savedMaterials : []).slice(0, 5).map((material, idx) => {
                  const materialId = material._id || material.id;
                  return (
                    <Link
                      key={materialId || idx}
                      href={`/marketplace/${materialId}`}
                      className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-gray-50 transition group"
                    >
                      <div className="w-8 h-8 rounded-md bg-rose-50 text-rose-500 flex items-center justify-center shrink-0">
                        <FaBookmark className="w-3 h-3" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-gray-700 truncate group-hover:text-blue-600 transition-colors">
                          {material.title || "Saved Resource"}
                        </p>
                        <p className="text-[10px] text-gray-400">
                          {material.subject || "Resource"}
                        </p>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          {/* Recommended Next Actions */}
          <section className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 rounded-xl p-5">
            <h2 className="text-sm font-bold text-gray-900 mb-4 flex items-center gap-2">
              <FaStar className="text-amber-500 w-3.5 h-3.5" />
              Recommended Actions
            </h2>
            <div className="space-y-3">
              {[
                { label: "Complete your profile for personalized recommendations", href: "/dashboard/settings" },
                { label: "Explore trending materials this week", href: "/marketplace" },
                { label: "Check out top-rated creators", href: "/marketplace" },
              ].map((action, i) => (
                <Link
                  key={i}
                  href={action.href}
                  className="flex items-center gap-3 text-xs text-gray-700 hover:text-blue-600 transition-colors group"
                >
                  <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-[10px] font-bold shrink-0 group-hover:bg-blue-600 group-hover:text-white transition-colors">
                    {i + 1}
                  </span>
                  <span className="leading-relaxed">{action.label}</span>
                </Link>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
