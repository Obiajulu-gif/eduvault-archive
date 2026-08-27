"use client";

import Link from "next/link";
import { FaArrowRight, FaBookmark, FaCompass, FaPlusCircle } from "react-icons/fa";

const QUICK_ACTIONS = [
  {
    id: "create-resource",
    title: "Create Resource",
    description: "Upload lessons, guides, or course materials with custom pricing and license terms.",
    href: "/dashboard/upload",
    icon: FaPlusCircle,
    badge: "Publish",
    accentColor: "from-blue-600 to-indigo-600",
    badgeBg: "bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800",
    hoverBorder: "hover:border-blue-500 dark:hover:border-blue-500",
  },
  {
    id: "browse-resources",
    title: "Browse Resources",
    description: "Explore catalog of verified educational materials by subject, category, level, and language.",
    href: "/marketplace",
    icon: FaCompass,
    badge: "Explore",
    accentColor: "from-emerald-600 to-teal-600",
    badgeBg: "bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800",
    hoverBorder: "hover:border-emerald-500 dark:hover:border-emerald-500",
  },
  {
    id: "saved-resources",
    title: "Saved Resources",
    description: "Access your bookmarked materials, purchased content, and study collections.",
    href: "/dashboard/library",
    icon: FaBookmark,
    badge: "Library",
    accentColor: "from-purple-600 to-pink-600",
    badgeBg: "bg-purple-50 dark:bg-purple-950/50 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800",
    hoverBorder: "hover:border-purple-500 dark:hover:border-purple-500",
  },
];

export default function QuickActions() {
  return (
    <section aria-labelledby="quick-actions-heading" className="w-full">
      <div className="flex items-center justify-between mb-4">
        <h2 id="quick-actions-heading" className="text-lg font-bold text-gray-900 dark:text-gray-100 tracking-tight">
          Quick Actions
        </h2>
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
          Fast Access Shortcuts
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {QUICK_ACTIONS.map((action) => {
          const Icon = action.icon;
          return (
            <Link
              key={action.id}
              href={action.href}
              className={`group relative bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl p-5 shadow-sm hover:shadow-md transition-all duration-300 flex flex-col justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${action.hoverBorder}`}
            >
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div className={`w-11 h-11 rounded-xl bg-gradient-to-br ${action.accentColor} text-white flex items-center justify-center shadow-sm group-hover:scale-105 transition-transform duration-300`}>
                    <Icon className="w-5 h-5" />
                  </div>
                  <span className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full border ${action.badgeBg}`}>
                    {action.badge}
                  </span>
                </div>

                <h3 className="text-base font-bold text-gray-900 dark:text-gray-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                  {action.title}
                </h3>
                <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
                  {action.description}
                </p>
              </div>

              <div className="mt-5 pt-3 border-t border-gray-100 dark:border-gray-800/80 flex items-center justify-between text-xs font-semibold text-gray-700 dark:text-gray-300 group-hover:text-blue-600 dark:group-hover:text-blue-400">
                <span>Open shortcut</span>
                <FaArrowRight className="w-3.5 h-3.5 transform group-hover:translate-x-1 transition-transform duration-300" />
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
