"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import { FaHeart, FaExclamationCircle } from "react-icons/fa";

import Navbar from "@/components/Navbar";

const categories = [
  "Past Questions & Exam Papers",
  "Project & School Development",
  "Social Sciences",
  "Education & Languages",
  "Medical & Biological Sciences",
  "Engineering & Tech",
  "Entrepreneurship",
  "Study Tools",
  "Faculty Notes",
  "Community and Learning Resources",
];

function shortenAddress(address) {
  if (!address) return "Anonymous";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export default function MarketPage() {
  const [materials, setMaterials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;

    const fetchMaterials = async () => {
      try {
        const res = await fetch("/api/market-materials");
        if (!res.ok) {
          throw new Error("Could not load marketplace materials.");
        }

        const data = await res.json();
        if (active) {
          setMaterials(data.items || []);
        }
      } catch (err) {
        console.error("Marketplace fetch failed:", err);
        if (active) {
          setError(err instanceof Error ? err.message : "Could not load marketplace materials.");
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
  }, []);

  return (
    <>
      <Navbar />

      <div
        className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(to_right,#f2ede8_1px,transparent_1px),linear-gradient(to_bottom,#f2ede8_1px,transparent_1px)] bg-[size:40px_40px] opacity-70"
        aria-hidden="true"
      />

      <section className="flex min-h-screen bg-[#fffaf6]">
        <aside className="hidden w-64 overflow-y-auto border-r border-gray-200 bg-white px-6 py-10 lg:block">
          <h3 className="mb-6 text-sm font-semibold text-gray-700">Categories</h3>
          <ul className="space-y-3 text-sm text-gray-600">
            {categories.map((category) => (
              <li key={category} className="cursor-pointer transition-all hover:text-blue-600">
                {category}
              </li>
            ))}
          </ul>
        </aside>

        <main className="flex-1 overflow-y-auto px-6 py-10 md:px-10">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="mb-10 flex flex-col items-center justify-between rounded-2xl bg-gradient-to-br from-yellow-100 to-orange-100 p-8 md:flex-row"
          >
            <div className="max-w-lg">
              <h1 className="mb-2 text-2xl font-bold text-gray-900 md:text-3xl">
                Discover More Study Materials
              </h1>
              <p className="mb-4 text-sm text-gray-700">
                Own your knowledge. Earn from your notes.
              </p>
              <Link
                href="/dashboard/upload"
                className="inline-block rounded-md bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-all hover:bg-blue-700"
              >
                Become a Creator
              </Link>
            </div>

            <div className="mt-6 flex h-40 w-40 items-center justify-center md:mt-0">
              <Image
                src="/images/stellar.png"
                alt="Stellar token"
                width={144}
                height={144}
                className="object-contain"
              />
            </div>
          </motion.div>

          <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <span className="font-medium">Filters:</span>
                <select className="rounded-md border border-gray-300 bg-white px-3 py-1 text-sm focus:ring-1 focus:ring-blue-300">
                  <option>Category: All</option>
                  <option>Social Sciences</option>
                  <option>Engineering</option>
                  <option>Pharmacy</option>
                </select>
              </div>
            </div>

            <div className="text-sm text-gray-600">
              Sort by:{" "}
              <select className="ml-1 rounded-md border border-gray-300 bg-white px-3 py-1 text-sm focus:ring-1 focus:ring-blue-300">
                <option>Newest</option>
                <option>Price: Low to High</option>
              </select>
            </div>
          </div>

          {loading && (
            <div className="flex flex-col items-center justify-center py-20">
              <div className="mb-4 h-10 w-10 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
              <p className="text-gray-600">Loading marketplace materials...</p>
            </div>
          )}

          {error && !loading && (
            <div className="flex items-center gap-4 rounded-2xl border border-red-200 bg-red-50 p-6 text-red-700">
              <FaExclamationCircle className="text-2xl" />
              <p>{error}</p>
            </div>
          )}

          {!loading && !error && materials.length === 0 && (
            <div className="rounded-2xl border border-gray-200 bg-white p-12 text-center shadow-sm">
              <p className="mb-2 text-gray-600">No public materials found.</p>
              <p className="text-sm text-gray-500">Be the first to upload one!</p>
            </div>
          )}

          {!loading && !error && materials.length > 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6 }}
              className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
            >
              {materials.map((material) => (
                <Link
                  href={`/marketplace/${material._id}`}
                  key={material._id}
                  className="block overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm transition-all duration-300 hover:shadow-md"
                >
                  <div className="relative h-44 w-full bg-gray-100">
                    {material.thumbnailUrl ? (
                      <Image
                        src={material.thumbnailUrl}
                        alt={material.title}
                        fill
                        className="object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-xs text-gray-400">
                        No Preview
                      </div>
                    )}
                    <button className="absolute left-3 top-3 rounded-full bg-white px-3 py-1 text-xs font-medium text-gray-700 shadow-sm transition hover:bg-gray-50">
                      Details
                    </button>
                  </div>

                  <div className="p-4">
                    <h3
                      className="mb-1 line-clamp-1 text-sm font-semibold text-gray-900"
                      title={material.title}
                    >
                      {material.title}
                    </h3>
                    <p className="mb-3 text-xs text-gray-500">
                      by {shortenAddress(material.userAddress)}
                    </p>

                    <div className="flex items-center justify-between border-t border-gray-50 pt-2 text-xs text-gray-500">
                      <div className="flex items-center gap-1">
                        <FaHeart className="text-pink-500" />
                        <span>0 Likes</span>
                      </div>
                      <span className="font-semibold text-gray-800">
                        {material.price > 0 ? `${material.price} XLM` : "Free"}
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
            </motion.div>
          )}
        </main>
      </section>
    </>
  );
}
