"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useParams } from "next/navigation";
import { motion } from "framer-motion";
import { FaHeart, FaCheckCircle, FaExclamationCircle } from "react-icons/fa";

import Navbar from "@/components/Navbar";
import BuyNowModal from "./modals/BuyNowModal";

export default function MaterialDetailsPage() {
  const { id } = useParams();
  const [material, setMaterial] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showBuyModal, setShowBuyModal] = useState(false);

  useEffect(() => {
    if (!id) return;

    let active = true;

    const fetchMaterial = async () => {
      setLoading(true);

      try {
        const res = await fetch(`/api/market-materials?id=${id}`);
        if (!res.ok) {
          if (res.status === 404) {
            throw new Error("Material not found.");
          }
          throw new Error("Could not load material details.");
        }

        const data = await res.json();
        if (active) {
          setMaterial(data);
        }
      } catch (err) {
        console.error("Detail fetch failed:", err);
        if (active) {
          setError(err instanceof Error ? err.message : "Could not load material details.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    fetchMaterial();
    return () => {
      active = false;
    };
  }, [id]);

  const formatDate = (timestamp) => {
    if (!timestamp) return "Unknown Date";
    const date = new Date(timestamp);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  if (loading) {
    return (
      <>
        <Navbar />
        <div className="flex min-h-screen flex-col items-center justify-center bg-[#fffaf6]">
          <div className="mb-4 h-12 w-12 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
          <p className="text-gray-600">Loading material details...</p>
        </div>
      </>
    );
  }

  if (error || !material) {
    return (
      <>
        <Navbar />
        <div className="flex min-h-screen flex-col items-center justify-center bg-[#fffaf6] px-6 text-center">
          <FaExclamationCircle className="mb-4 text-5xl text-red-500" />
          <h1 className="mb-2 text-2xl font-bold text-gray-900">
            Material Not Found
          </h1>
          <p className="mb-6 max-w-md text-gray-600">
            {error || "The material you are looking for does not exist or has been removed."}
          </p>
          <Link
            href="/marketplace"
            className="rounded-md bg-blue-600 px-6 py-2 font-semibold text-white transition hover:bg-blue-700"
          >
            Back to Marketplace
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <Navbar />

      <section className="relative min-h-screen bg-[#fffaf6] px-6 py-10 md:px-20">
        <div
          className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(to_right,#f2ede8_1px,transparent_1px),linear-gradient(to_bottom,#f2ede8_1px,transparent_1px)] bg-[size:40px_40px] opacity-70"
          aria-hidden="true"
        />

        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="mx-auto max-w-6xl"
        >
          <p className="mb-6 text-sm text-gray-500">
            <Link href="/marketplace" className="text-blue-600 hover:underline">
              Marketplace
            </Link>{" "}
            → {material.title.slice(0, 20)}...
          </p>

          <div className="flex flex-col gap-10 md:flex-row">
            <div className="relative flex-1 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm aspect-video">
              {material.thumbnailUrl ? (
                <Image
                  src={material.thumbnailUrl}
                  alt={material.title}
                  fill
                  className="object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-gray-400">
                  No Preview Available
                </div>
              )}
            </div>

            <div className="flex-1 space-y-5">
              <h1 className="text-2xl font-bold text-gray-900 md:text-3xl">
                {material.title}
              </h1>
              <p className="text-sm leading-relaxed text-gray-600">
                {material.description || "No description provided for this material."}
              </p>

              <div className="mt-4 flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <Image
                    src="/images/stellar.png"
                    alt="Stellar"
                    width={28}
                    height={28}
                    className="rounded-full"
                  />
                  <span className="text-lg font-semibold text-gray-900">
                    {material.price > 0 ? `${material.price} XLM` : "Free"}
                  </span>
                </div>
                <span className="text-sm text-yellow-500">⭐ 0.0</span>
                <span className="text-sm text-gray-400">(0 Reviews)</span>
              </div>

              <div className="mt-4 flex items-center gap-3">
                <button className="rounded-md border border-gray-300 px-6 py-2 font-semibold text-gray-700 transition hover:bg-gray-100">
                  Add to Cart
                </button>
                <button
                  onClick={() => setShowBuyModal(true)}
                  className="rounded-md bg-blue-600 px-6 py-2 font-semibold text-white transition hover:bg-blue-700"
                >
                  Buy Now!
                </button>
              </div>

              <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
                <FaHeart className="text-pink-500" />
                0 Likes
              </div>
            </div>
          </div>

          <div className="mt-10 grid gap-6 md:grid-cols-2">
            <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
              <h2 className="mb-3 text-lg font-semibold text-gray-900">
                Material Overview
              </h2>
              <div className="space-y-4 text-sm text-gray-600">
                <p className="leading-relaxed">
                  {material.description || "No additional information provided."}
                </p>
                {material.usageRights && (
                  <div>
                    <strong className="text-gray-800">Usage Rights:</strong>
                    <p className="mt-1">{material.usageRights}</p>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
              <h2 className="mb-3 text-lg font-semibold text-gray-900">
                Creator Info
              </h2>
              <div className="space-y-3 text-sm text-gray-600">
                <p>
                  <strong className="text-gray-800">Creator Address:</strong>{" "}
                  <span className="break-all">
                    {material.userAddress || "Anonymous"}
                  </span>
                </p>
                <p>
                  <strong className="text-gray-800">Uploaded On:</strong>{" "}
                  {formatDate(material.createdAt)}
                </p>
                <p>
                  <strong className="text-gray-800">Visibility:</strong>{" "}
                  <span className="capitalize">{material.visibility}</span>
                </p>
                <div className="pt-2">
                  <p className="flex items-center gap-2">
                    <strong className="text-gray-800">Status:</strong>
                    <span className="flex items-center gap-1 rounded-full bg-green-50 px-2 py-1 text-xs font-medium text-green-600">
                      <FaCheckCircle /> Verified Canonical Record
                    </span>
                  </p>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </section>

      <BuyNowModal
        isOpen={showBuyModal}
        onClose={() => setShowBuyModal(false)}
        price={material.price > 0 ? `${material.price} XLM` : "Free"}
      />
    </>
  );
}
