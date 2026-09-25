"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FaChevronLeft, FaChevronRight, FaSpinner } from "react-icons/fa";
import {
  getArchivedIds,
  archiveResource,
  restoreResource,
} from "@/lib/resourceArchive";

const PAGE_SIZE = 10;

async function fetchCreatorMaterials(page, limit) {
  const res = await fetch(`/api/creator/materials?page=${page}&limit=${limit}`);
  if (!res.ok) throw new Error("Failed to fetch materials");
  return res.json();
}

function Pagination({ page, totalPages, onPageChange }) {
  if (totalPages <= 1) return null;

  const pages = [];
  const delta = 2;
  const left = Math.max(2, page - delta);
  const right = Math.min(totalPages - 1, page + delta);

  pages.push(1);
  if (left > 2) pages.push("...");
  for (let i = left; i <= right; i++) pages.push(i);
  if (right < totalPages - 1) pages.push("...");
  if (totalPages > 1) pages.push(totalPages);

  return (
    <nav aria-label="Pagination" className="flex items-center justify-center gap-1 mt-8">
      <button
        onClick={() => onPageChange(page - 1)}
        disabled={page === 1}
        aria-label="Previous page"
        className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <FaChevronLeft size={12} />
        Previous
      </button>

      {pages.map((p, i) =>
        p === "..." ? (
          <span key={`ellipsis-${i}`} className="px-2 py-2 text-sm text-gray-400 select-none">
            …
          </span>
        ) : (
          <button
            key={p}
            onClick={() => onPageChange(p)}
            aria-label={`Page ${p}`}
            aria-current={p === page ? "page" : undefined}
            className={`w-9 h-9 rounded-lg text-sm font-medium transition-colors ${
              p === page
                ? "bg-blue-600 text-white shadow-sm"
                : "border border-gray-200 text-gray-700 hover:bg-gray-50"
            }`}
          >
            {p}
          </button>
        )
      )}

      <button
        onClick={() => onPageChange(page + 1)}
        disabled={page === totalPages}
        aria-label="Next page"
        className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Next
        <FaChevronRight size={12} />
      </button>
    </nav>
  );
}

export default function CreatorInventory() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [materials, setMaterials] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [archivedIds, setArchivedIds] = useState([]);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    setArchivedIds(getArchivedIds());
  }, []);

  async function handleArchive(id) {
    try {
      const updated = await archiveResource(id);
      setArchivedIds([...updated]);
    } catch (err) {
      console.error("Archive failed:", err);
    }
  }

  async function handleRestore(id) {
    try {
      const updated = await restoreResource(id);
      setArchivedIds([...updated]);
    } catch (err) {
      console.error("Restore failed:", err);
    }
  }

  // Read page from URL query; default to 1
  const currentPage = Math.max(1, parseInt(searchParams.get("page") || "1", 10));

  const load = useCallback(async (page) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchCreatorMaterials(page, PAGE_SIZE);
      setMaterials(data.materials);
      setTotal(data.total);
      setTotalPages(data.totalPages);
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(currentPage);
  }, [currentPage, load]);

  function handlePageChange(newPage) {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set("page", String(newPage));
    router.push(`?${params.toString()}`, { scroll: false });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-900">My Inventory</h2>
          {!loading && !error && (
            <p className="text-sm text-gray-500 mt-0.5">
              {total} material{total !== 1 ? "s" : ""} total
              {archivedIds.length > 0 && ` · ${archivedIds.length} archived`}
            </p>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="rounded border-gray-300"
          />
          Show archived
        </label>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <FaSpinner className="animate-spin text-blue-500 text-2xl" />
        </div>
      )}

      {error && !loading && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
          {error}
        </div>
      )}

      {!loading && !error && materials.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <p className="text-gray-500 text-sm mb-4">No materials uploaded yet.</p>
          <a
            href="/dashboard/upload"
            className="px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-full hover:bg-blue-700 transition-colors"
          >
            Upload Material
          </a>
        </div>
      )}

      {!loading && !error && materials.length > 0 && (
        <>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {materials
              .filter((m) => showArchived || !archivedIds.includes(m._id))
              .map((m) => {
                const archived = archivedIds.includes(m._id);
                return (
                  <div
                    key={m._id}
                    className={`bg-white rounded-xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow p-5 flex flex-col gap-2 ${
                      archived ? "opacity-70" : ""
                    }`}
                  >
                    <div className="h-28 bg-gradient-to-br from-blue-50 to-purple-50 rounded-lg flex items-center justify-center overflow-hidden mb-1">
                      {m.thumbnailUrl ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img src={m.thumbnailUrl} alt={m.title} className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-4xl">📄</span>
                      )}
                    </div>

                    <div className="flex items-start justify-between gap-2">
                      <h3 className="font-semibold text-sm text-gray-900 line-clamp-2">{m.title}</h3>
                      {archived && (
                        <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-600 border border-gray-200">
                          Archived
                        </span>
                      )}
                    </div>

                    {m.description && (
                      <p className="text-xs text-gray-500 line-clamp-2">{m.description}</p>
                    )}

                    <div className="flex items-center justify-between text-xs text-gray-400 mt-auto pt-2">
                      <span>{m.price ? `${m.price} XLM` : "Free"}</span>
                      <span className={m.visibility === "public" ? "text-green-600" : "text-amber-600"}>
                        {m.visibility}
                      </span>
                    </div>

                    {archived ? (
                      <button
                        onClick={() => handleRestore(m._id)}
                        className="mt-2 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        Restore
                      </button>
                    ) : (
                      <button
                        onClick={() => handleArchive(m._id)}
                        className="mt-2 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors"
                      >
                        Archive
                      </button>
                    )}
                  </div>
                );
              })}
          </div>

          <Pagination
            page={currentPage}
            totalPages={totalPages}
            onPageChange={handlePageChange}
          />

          <p className="text-center text-xs text-gray-400 mt-3">
            Page {currentPage} of {totalPages}
          </p>
        </>
      )}
    </div>
  );
}
