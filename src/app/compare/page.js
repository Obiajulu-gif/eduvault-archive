"use client";

import { useEffect, useState } from "react";
import Navbar from "@/components/Navbar";
import CatalogComparison from "@/components/CatalogComparison";

export default function ComparePage() {
  const [materials, setMaterials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchMaterials() {
      try {
        setLoading(true);
        const res = await fetch("/api/market-materials?pageSize=50");
        if (!res.ok) throw new Error("Failed to fetch materials");
        const data = await res.json();
        setMaterials(data.items || data.materials || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    fetchMaterials();
  }, []);

  return (
    <>
      <Navbar />

      <main className="min-h-screen bg-[#fffaf6] px-4 md:px-8 py-8">
        <div className="max-w-7xl mx-auto">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-gray-900">
              Course Comparison
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              Select two materials to compare side by side. Zoom and pan over document previews to inspect details.
            </p>
          </div>

          {loading ? (
            <div className="grid grid-cols-2 gap-4">
              {[1, 2].map((i) => (
                <div
                  key={i}
                  className="bg-white rounded-xl border border-gray-200 p-5 animate-pulse h-96"
                />
              ))}
            </div>
          ) : error ? (
            <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
              <p className="text-red-600 font-medium">{error}</p>
              <p className="text-gray-500 text-sm mt-2">
                Unable to load materials for comparison.
              </p>
            </div>
          ) : (
            <CatalogComparison materials={materials} />
          )}
        </div>
      </main>
    </>
  );
}
