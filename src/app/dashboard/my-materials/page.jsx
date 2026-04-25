"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";

export default function MyMaterialsPage() {
  const { address } = useAccount();
  const [materials, setMaterials] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!address) return;

    let active = true;

    const fetchMaterials = async () => {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch("/api/materials", { cache: "no-store" });
        if (!res.ok) {
          if (res.status === 401) {
            throw new Error("Please sign in to view your materials.");
          }
          throw new Error("Failed to fetch materials from the canonical record.");
        }

        const data = await res.json();
        if (active) {
          setMaterials(Array.isArray(data) ? data : []);
        }
      } catch (err) {
        console.error("Error fetching materials:", err);
        if (active) {
          setError(err instanceof Error ? err.message : "Error loading materials.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    fetchMaterials();
    return () => {
      active = false;
    };
  }, [address]);

  const formatDate = (timestamp) => {
    if (!timestamp) return "Unknown";
    const date = new Date(timestamp);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
    });
  };

  if (!address) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-600">
          Connect your wallet to view your uploaded materials.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center gap-2">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
          <p className="text-sm text-gray-600">Loading your materials...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-6 text-center">
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-2xl font-bold">My Materials</h1>
          <span className="rounded-md bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700">
            {materials.length} Items
          </span>
        </div>

        {materials.length === 0 ? (
          <div className="rounded-2xl border border-gray-200 bg-white p-12 text-center shadow-sm">
            <p className="mb-4 text-sm text-gray-600">
              No materials found for this wallet.
            </p>
            <Link
              href="/dashboard/upload"
              className="text-sm font-medium text-blue-600 hover:underline"
            >
              Upload your first material
            </Link>
          </div>
        ) : (
          <ul className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {materials.map((item) => (
              <li
                key={item._id || item.materialId}
                className="flex flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm transition hover:shadow-md"
              >
                <div className="relative h-44 bg-gray-100">
                  {item.thumbnailUrl ? (
                    <img
                      src={item.thumbnailUrl}
                      alt={item.title}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-gray-400">
                      <span className="text-xs">No preview available</span>
                    </div>
                  )}
                  <div className="absolute right-3 top-3">
                    <span
                      className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase shadow-sm ${
                        item.visibility === "public"
                          ? "bg-green-100 text-green-700"
                          : "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {item.visibility}
                    </span>
                  </div>
                </div>

                <div className="flex flex-1 flex-col p-5">
                  <h3 className="mb-2 line-clamp-1 text-lg font-semibold" title={item.title}>
                    {item.title}
                  </h3>
                  {item.description && (
                    <p className="mb-4 line-clamp-2 flex-1 text-sm text-gray-600">
                      {item.description}
                    </p>
                  )}

                  <div className="space-y-2 border-t border-gray-50 pt-4">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-500">Price</span>
                      <span className="font-semibold text-gray-900">
                        {item.price > 0 ? `${item.price} XLM` : "Free"}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-500">Created</span>
                      <span className="text-gray-700">{formatDate(item.createdAt)}</span>
                    </div>
                  </div>

                  {item.fileUrl && (
                    <div className="mt-5">
                      <a
                        href={item.fileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block w-full rounded-lg bg-blue-600 py-2 text-center text-sm font-medium text-white transition hover:bg-blue-700"
                      >
                        View Material
                      </a>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
