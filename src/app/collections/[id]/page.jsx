"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { FiArrowLeft, FiBox } from "react-icons/fi";

export default function CollectionDetailPage() {
  const params = useParams();
  const [collection, setCollection] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchCollection() {
      try {
        const res = await fetch(`/api/collections/${params.id}`);
        if (res.ok) {
          const data = await res.json();
          setCollection(data);
        }
      } catch (err) {
        console.error("Failed to fetch collection details", err);
      } finally {
        setLoading(false);
      }
    }
    if (params?.id) {
      fetchCollection();
    }
  }, [params?.id]);

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-4xl animate-pulse">
        <div className="h-8 bg-gray-200 dark:bg-gray-800 rounded w-1/4 mb-4"></div>
        <div className="h-10 bg-gray-200 dark:bg-gray-800 rounded w-3/4 mb-4"></div>
        <div className="h-20 bg-gray-200 dark:bg-gray-800 rounded w-full mb-8"></div>
        <div className="space-y-4">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-32 bg-gray-200 dark:bg-gray-800 rounded"></div>
          ))}
        </div>
      </div>
    );
  }

  if (!collection) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <h2 className="text-2xl font-bold mb-4">Collection not found</h2>
        <Link href="/collections" className="text-blue-500 hover:underline">
          &larr; Back to collections
        </Link>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <Link href="/collections" className="inline-flex items-center text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 mb-6 transition-colors">
        <FiArrowLeft className="mr-2" /> Back to Collections
      </Link>

      <div className="mb-10">
        <h1 className="text-4xl font-extrabold tracking-tight mb-4">{collection.title}</h1>
        <p className="text-lg text-gray-600 dark:text-gray-300">
          {collection.description}
        </p>
      </div>

      <div>
        <h2 className="text-2xl font-bold mb-6 flex items-center">
          <FiBox className="mr-3 text-blue-500" />
          Included Resources ({collection.materials?.length || 0})
        </h2>

        {!collection.materials || collection.materials.length === 0 ? (
          <div className="text-center py-12 bg-gray-50 dark:bg-gray-900 rounded-xl border border-dashed border-gray-300 dark:border-gray-700">
            <p className="text-gray-500">No resources have been added to this collection yet.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {collection.materials.map(material => (
              <div key={material._id} className="p-6 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h3 className="text-xl font-semibold mb-1">{material.title || "Untitled Material"}</h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400 line-clamp-2">
                    {material.description || "No description available."}
                  </p>
                </div>
                {/* Normally we'd link to the material page */}
                <Link href={`/marketplace/materials/${material._id}`} className="px-5 py-2.5 bg-blue-500 hover:bg-blue-600 text-white font-medium rounded-lg text-center whitespace-nowrap transition-colors">
                  View Resource
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
