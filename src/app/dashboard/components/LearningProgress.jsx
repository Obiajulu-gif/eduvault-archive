"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { FiCheckCircle, FiBook } from "react-icons/fi";

export default function LearningProgress() {
  const [progress, setProgress] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchProgress() {
      try {
        const res = await fetch("/api/progress");
        if (res.ok) {
          const data = await res.json();
          setProgress(data);
        }
      } catch (err) {
        console.error("Failed to fetch progress", err);
      } finally {
        setLoading(false);
      }
    }
    fetchProgress();
  }, []);

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-6">
        <div className="h-6 w-1/3 bg-gray-200 dark:bg-gray-800 rounded mb-4 animate-pulse"></div>
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-12 w-full bg-gray-100 dark:bg-gray-800 rounded animate-pulse"></div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-6">
      <h2 className="text-xl font-bold mb-4 flex items-center">
        <FiCheckCircle className="mr-2 text-green-500" /> My Learning Progress
      </h2>

      {progress.length === 0 ? (
        <div className="text-center py-6">
          <FiBook className="w-10 h-10 text-gray-300 mx-auto mb-2" />
          <p className="text-gray-500 text-sm">You haven&#39;t completed any resources yet.</p>
          <Link href="/marketplace" className="text-blue-500 text-sm hover:underline mt-2 inline-block">
            Explore marketplace
          </Link>
        </div>
      ) : (
        <div>
          <div className="mb-4">
            <div className="flex justify-between items-center mb-1">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">Total Completed</span>
              <span className="text-lg font-bold">{progress.length}</span>
            </div>
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
              <div className="bg-green-500 h-2 rounded-full" style={{ width: '100%' }}></div>
            </div>
          </div>
          
          <div className="space-y-3 mt-4 max-h-60 overflow-y-auto">
            {progress.slice(0, 5).map((item) => (
              <Link 
                key={item._id} 
                href={`/marketplace/materials/${item.materialId}`}
                className="flex items-center p-3 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg transition-colors border border-transparent hover:border-gray-200 dark:hover:border-gray-700"
              >
                <div className="bg-green-100 dark:bg-green-900/30 p-2 rounded-full mr-3 text-green-600 dark:text-green-400">
                  <FiCheckCircle size={16} />
                </div>
                <div>
                  <div className="font-medium text-sm text-gray-900 dark:text-white truncate max-w-xs">
                    {item.material?.title || "Unknown Resource"}
                  </div>
                  <div className="text-xs text-gray-500">
                    {new Date(item.completedAt).toLocaleDateString()}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}