"use client";

import { useMemo, useState } from "react";
import { FaSearch } from "react-icons/fa";

export const SORT_OPTIONS = [
  { value: "date-desc", label: "Purchase Date (Newest)" },
  { value: "date-asc", label: "Purchase Date (Oldest)" },
  { value: "creator", label: "Creator Name" },
  { value: "type", label: "Resource Type" },
];

function purchaseTime(item) {
  const raw = item.purchasedAt || item.purchaseDate || item.createdAt;
  const t = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

function creatorName(item) {
  return (item.creatorName || item.author || item.creator || "").toLowerCase();
}

function resourceType(item) {
  return (item.resourceType || item.fileType || item.type || "").toLowerCase();
}

/**
 * Sort + filter library items. Exported for direct unit testing.
 *
 * @param {Array}  items   owned library materials
 * @param {string} sortBy  one of SORT_OPTIONS values
 * @param {string} query   case-insensitive title/creator filter
 */
export function sortAndFilterLibrary(items, sortBy, query) {
  const q = (query || "").trim().toLowerCase();
  const filtered = q
    ? items.filter(
        (item) =>
          (item.title || "").toLowerCase().includes(q) ||
          creatorName(item).includes(q),
      )
    : [...items];

  switch (sortBy) {
    case "date-asc":
      return filtered.sort((a, b) => purchaseTime(a) - purchaseTime(b));
    case "creator":
      return filtered.sort((a, b) => creatorName(a).localeCompare(creatorName(b)));
    case "type":
      return filtered.sort((a, b) => resourceType(a).localeCompare(resourceType(b)));
    case "date-desc":
    default:
      return filtered.sort((a, b) => purchaseTime(b) - purchaseTime(a));
  }
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * LibraryList — the learner's owned materials with sorting and filtering.
 * Sorting/filtering is purely client-side, so changing either re-orders the
 * table immediately without a reload or refetch.
 */
export default function LibraryList({ items = [], isLoading = false }) {
  const [sortBy, setSortBy] = useState("date-desc");
  const [query, setQuery] = useState("");

  const visible = useMemo(
    () => sortAndFilterLibrary(items, sortBy, query),
    [items, sortBy, query],
  );

  if (isLoading) {
    return <p className="text-sm text-gray-500 py-10 text-center">Loading your library…</p>;
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <div className="relative flex-1">
          <FaSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your library…"
            aria-label="Search your library"
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          Sort by
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            aria-label="Sort library items"
            className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {visible.length === 0 ? (
        <p className="text-sm text-gray-500 py-10 text-center">
          {items.length === 0
            ? "No materials in your library yet."
            : "No materials match your search."}
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
              <th className="py-2 pr-4 font-medium">Title</th>
              <th className="py-2 pr-4 font-medium">Creator</th>
              <th className="py-2 pr-4 font-medium">Type</th>
              <th className="py-2 font-medium">Purchased</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => (
              <tr
                key={item._id || item.id || item.materialId}
                className="border-b border-gray-50 hover:bg-gray-50/60"
              >
                <td className="py-2.5 pr-4 font-medium text-gray-900">{item.title}</td>
                <td className="py-2.5 pr-4 text-gray-600">
                  {item.creatorName || item.author || item.creator || "—"}
                </td>
                <td className="py-2.5 pr-4 text-gray-600 uppercase text-xs">
                  {item.resourceType || item.fileType || item.type || "—"}
                </td>
                <td className="py-2.5 text-gray-500">
                  {formatDate(item.purchasedAt || item.purchaseDate || item.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
