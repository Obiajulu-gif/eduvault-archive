"use client";

import { useEffect, useState, useCallback } from "react";
import { FaDownload, FaExternalLinkAlt, FaShoppingBag, FaSpinner, FaCheckCircle } from "react-icons/fa";
import { MdOutlineSchool } from "react-icons/md";

function formatDate(dateStr) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function truncateHash(hash) {
  if (!hash) return "—";
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

// ─── Skeleton card ────────────────────────────────────────────────────────────
function SkeletonCard() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 animate-pulse">
      <div className="w-full h-36 bg-gray-200 rounded-lg mb-4" />
      <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
      <div className="h-3 bg-gray-200 rounded w-1/2 mb-4" />
      <div className="flex gap-2">
        <div className="h-8 bg-gray-200 rounded-lg flex-1" />
        <div className="h-8 bg-gray-200 rounded-lg w-10" />
      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-20 h-20 rounded-full bg-blue-50 flex items-center justify-center mb-5">
        <MdOutlineSchool className="text-blue-400 text-4xl" />
      </div>
      <h2 className="text-xl font-semibold text-gray-800 mb-2">No purchases yet</h2>
      <p className="text-sm text-gray-500 max-w-xs mb-6">
        Head over to the marketplace to discover and purchase educational materials.
      </p>
      <a
        href="/dashboard/market"
        className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-full hover:bg-blue-700 transition-colors"
      >
        <FaShoppingBag size={14} />
        Browse Marketplace
      </a>
    </div>
  );
}

// ─── Material card ────────────────────────────────────────────────────────────
function PurchasedMaterialCard({ item }) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(null);

  const handleDownload = useCallback(async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const res = await fetch(`/api/materials/download/${item.materialId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Download failed");
      }
      const { downloadUrl, title } = await res.json();
      // Open in new tab — browser handles PDF/image inline or triggers download
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.download = title || "material";
      anchor.click();
    } catch (err) {
      setDownloadError(err.message);
    } finally {
      setDownloading(false);
    }
  }, [item.materialId]);

  const material = item.material;
  const title = material?.title || `Material #${item.materialId}`;
  const description = material?.description || "";
  const price = material?.price != null ? `${material.price} XLM` : "—";

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow flex flex-col">
      {/* Thumbnail / placeholder */}
      <div className="w-full h-36 bg-gradient-to-br from-blue-50 to-purple-50 rounded-t-xl flex items-center justify-center overflow-hidden">
        {material?.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={material.thumbnailUrl}
            alt={title}
            className="w-full h-full object-cover"
          />
        ) : (
          <MdOutlineSchool className="text-blue-300 text-5xl" />
        )}
      </div>

      <div className="p-5 flex flex-col flex-1">
        <h3 className="font-semibold text-gray-900 text-sm leading-snug mb-1 line-clamp-2">
          {title}
        </h3>

        {description && (
          <p className="text-xs text-gray-500 line-clamp-2 mb-3">{description}</p>
        )}

        <div className="mt-auto space-y-2">
          {/* Purchase meta */}
          <div className="flex items-center justify-between text-xs text-gray-400">
            <span>Purchased {formatDate(item.purchasedAt)}</span>
            <span className="flex items-center gap-1 text-green-600 font-medium">
              <FaCheckCircle size={10} /> Verified
            </span>
          </div>

          <div className="flex items-center gap-1 text-xs text-gray-400">
            <span className="font-medium text-gray-500">Tx:</span>
            <span className="font-mono">{truncateHash(item.transactionHash)}</span>
            {item.transactionHash && (
              <a
                href={`https://stellar.expert/explorer/testnet/tx/${item.transactionHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1 text-blue-400 hover:text-blue-600"
                title="View on Stellar Explorer"
              >
                <FaExternalLinkAlt size={10} />
              </a>
            )}
          </div>

          {downloadError && (
            <p className="text-xs text-red-500">{downloadError}</p>
          )}

          {/* Actions */}
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="w-full flex items-center justify-center gap-2 py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {downloading ? (
              <FaSpinner className="animate-spin" size={14} />
            ) : (
              <FaDownload size={14} />
            )}
            {downloading ? "Preparing…" : "Download / View"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function PurchasesPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/purchased-materials");
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Failed to load purchases");
        }
        const data = await res.json();
        if (!cancelled) setItems(data);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">My Purchases</h1>
        <p className="text-sm text-gray-500">
          Materials you own — access is verified by your on-chain entitlement.
        </p>
      </div>

      {/* Content */}
      {loading && (
        <div className="grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <p className="text-red-500 text-sm mb-4">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="text-sm text-blue-600 underline"
          >
            Try again
          </button>
        </div>
      )}

      {!loading && !error && items.length === 0 && <EmptyState />}

      {!loading && !error && items.length > 0 && (
        <>
          <p className="text-xs text-gray-400 mb-4">
            {items.length} {items.length === 1 ? "item" : "items"} purchased
          </p>
          <div className="grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {items.map((item) => (
              <PurchasedMaterialCard key={item.purchaseId} item={item} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
