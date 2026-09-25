"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { FiBookOpen } from "react-icons/fi";

export default function CollectionsPage() {
  const [collections, setCollections] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchCollections() {
      try {
        const res = await fetch("/api/collections");
        if (res.ok) {
          const data = await res.json();
          setCollections(data);
        }
      } catch (err) {
        console.error("Failed to fetch collections", err);
      } finally {
        setLoading(false);
      }
    }
    fetchCollections();
  }, []);

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Learning Collections</h1>
        <p className="text-gray-600 dark:text-gray-400">
          Discover curated groups of resources to master new skills.
        </p>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <div key={i} className="animate-pulse bg-gray-200 dark:bg-gray-800 rounded-xl h-48"></div>
          ))}
        </div>
      ) : collections.length === 0 ? (
        <div className="text-center py-20 bg-gray-50 dark:bg-gray-800/50 rounded-2xl border border-gray-100 dark:border-gray-800">
          <FiBookOpen className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-xl font-semibold mb-2">No collections yet</h3>
          <p className="text-gray-500">Check back later for curated learning paths.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {collections.map((col) => (
            <Link key={col._id} href={`/collections/${col._id}`}>
              <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-6 hover:shadow-lg hover:border-blue-500 transition-all cursor-pointer h-full flex flex-col">
                <h3 className="text-xl font-bold mb-2">{col.title}</h3>
                <p className="text-gray-600 dark:text-gray-400 line-clamp-3 mb-4 flex-grow">
                  {col.description}
                </p>
                <div className="text-sm font-medium text-blue-600 dark:text-blue-400 mt-auto">
                  {col.materialIds?.length || 0} resources included &rarr;
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
