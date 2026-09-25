"use client";

import { useState, useEffect } from "react";
import { FiActivity, FiUploadCloud, FiTrendingUp, FiDollarSign } from "react-icons/fi";

export default function EducatorActivitySummary({ user }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // This is a placeholder since we don't have a specific API for educator activity yet.
    // In a real app, we'd fetch from an API like `/api/educator/stats`.
    // For now, we simulate fetching some stats.
    const fetchStats = async () => {
      try {
        // Simulating an API call delay
        await new Promise(resolve => setTimeout(resolve, 800));
        setStats({
          totalResources: 12,
          activeLearners: 145,
          totalRevenue: 350.50,
          recentViews: 1240
        });
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchStats();
  }, [user]);

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-6 animate-pulse mt-8">
        <div className="h-6 w-1/4 bg-gray-200 dark:bg-gray-800 rounded mb-6"></div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-24 bg-gray-100 dark:bg-gray-800 rounded-lg"></div>
          ))}
        </div>
      </div>
    );
  }

  // Handle empty state if no resources
  if (stats?.totalResources === 0) {
    return (
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-8 text-center mt-8">
        <FiUploadCloud className="w-12 h-12 text-gray-300 mx-auto mb-4" />
        <h3 className="text-xl font-bold mb-2">Start your creator journey</h3>
        <p className="text-gray-500 mb-6">Upload your first educational resource to see your activity summary here.</p>
        <button className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-6 rounded-lg transition-colors">
          Upload Resource
        </button>
      </div>
    );
  }

  return (
    <div className="bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-indigo-950/30 dark:to-blue-950/30 border border-indigo-100 dark:border-indigo-900/50 rounded-xl p-6 mt-8">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold flex items-center text-indigo-900 dark:text-indigo-100">
          <FiActivity className="mr-2" /> Educator Activity Summary
        </h2>
        <span className="text-sm px-3 py-1 bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 rounded-full font-medium">
          Last 30 Days
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-900 rounded-lg p-4 shadow-sm border border-gray-100 dark:border-gray-800">
          <div className="text-gray-500 dark:text-gray-400 text-sm mb-1 font-medium">Total Resources</div>
          <div className="text-2xl font-bold">{stats.totalResources}</div>
        </div>
        
        <div className="bg-white dark:bg-gray-900 rounded-lg p-4 shadow-sm border border-gray-100 dark:border-gray-800">
          <div className="text-gray-500 dark:text-gray-400 text-sm mb-1 font-medium flex items-center">
            Active Learners
          </div>
          <div className="text-2xl font-bold">{stats.activeLearners}</div>
        </div>
        
        <div className="bg-white dark:bg-gray-900 rounded-lg p-4 shadow-sm border border-gray-100 dark:border-gray-800">
          <div className="text-gray-500 dark:text-gray-400 text-sm mb-1 font-medium flex items-center">
             Total Views
          </div>
          <div className="text-2xl font-bold flex items-center">
            {stats.recentViews.toLocaleString()}
            <FiTrendingUp className="ml-2 text-green-500 text-sm" />
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-lg p-4 shadow-sm border border-gray-100 dark:border-gray-800">
          <div className="text-gray-500 dark:text-gray-400 text-sm mb-1 font-medium flex items-center">
             Revenue
          </div>
          <div className="text-2xl font-bold flex items-center text-green-600 dark:text-green-400">
            <FiDollarSign className="mr-0.5 text-lg" />
            {stats.totalRevenue.toFixed(2)}
          </div>
        </div>
      </div>
    </div>
  );
}
