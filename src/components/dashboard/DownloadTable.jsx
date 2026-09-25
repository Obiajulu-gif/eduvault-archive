"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  FaDownload,
  FaSearch,
  FaFilter,
  FaCheckCircle,
  FaClock,
  FaTimesCircle,
  FaFileExport,
  FaChevronLeft,
  FaChevronRight,
  FaInbox,
  FaExclamationTriangle,
  FaSpinner,
} from "react-icons/fa";

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "completed", label: "Completed" },
  { value: "pending", label: "Pending" },
  { value: "failed", label: "Failed" },
];

const PAGE_SIZES = [10, 20, 50];

/** Format an ISO date string to a human-readable locale date + time. */
function formatDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Truncate a long wallet address for display. */
function truncateAddress(address) {
  if (!address || address === "Unknown") return "—";
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

/** Status badge rendered inline in each row. */
function StatusBadge({ status }) {
  const map = {
    completed: {
      icon: <FaCheckCircle className="shrink-0" aria-hidden="true" />,
      label: "Completed",
      className: "bg-emerald-50 text-emerald-700 border-emerald-200",
    },
    pending: {
      icon: <FaClock className="shrink-0" aria-hidden="true" />,
      label: "Pending",
      className: "bg-amber-50 text-amber-700 border-amber-200",
    },
    failed: {
      icon: <FaTimesCircle className="shrink-0" aria-hidden="true" />,
      label: "Failed",
      className: "bg-red-50 text-red-700 border-red-200",
    },
  };

  const config = map[status] ?? map.failed;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${config.className}`}
    >
      {config.icon}
      {config.label}
    </span>
  );
}

/** Single skeleton row for the loading state. */
function SkeletonRow() {
  return (
    <tr aria-hidden="true">
      {Array.from({ length: 5 }).map((_, i) => (
        <td key={i} className="px-5 py-4">
          <div className="h-3.5 animate-pulse rounded bg-border-subtle" />
        </td>
      ))}
    </tr>
  );
}

/** Empty-state illustration shown when there are no download records. */
function EmptyState({ hasFilter }) {
  return (
    <tr>
      <td colSpan={5}>
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-surface-muted">
            <FaInbox className="text-3xl text-muted-foreground" aria-hidden="true" />
          </div>
          <h3 className="text-base font-semibold text-foreground">
            {hasFilter ? "No matching download logs" : "No download logs yet"}
          </h3>
          <p className="mt-1 max-w-xs text-sm text-muted-foreground">
            {hasFilter
              ? "Try adjusting your filters or search term."
              : "Download events will appear here once buyers access your materials."}
          </p>
        </div>
      </td>
    </tr>
  );
}

/**
 * DownloadTable — paginated, filterable table of download events.
 *
 * Fetches from GET /api/creator/download-logs with page, limit, status, and
 * search params. Supports JSON export of the current filtered result set.
 *
 * @param {{ initialPage?: number }} props
 */
export default function DownloadTable({ initialPage = 1 }) {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);

  const [page, setPage] = useState(initialPage);
  const [limit, setLimit] = useState(20);
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  // Debounce the search input (300 ms) to avoid hammering the API on every keystroke.
  const debounceTimer = useRef(null);
  const handleSearchChange = useCallback((e) => {
    const value = e.target.value;
    setSearchTerm(value);
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedSearch(value);
      setPage(1);
    }, 300);
  }, []);

  // Reset to page 1 when filters change.
  useEffect(() => {
    setPage(1);
  }, [statusFilter, limit]);

  // Fetch whenever page / limit / filter / search changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      status: statusFilter,
    });
    if (debouncedSearch) params.set("search", debouncedSearch);

    fetch(`/api/creator/download-logs?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.detail || body.error || `Request failed (${res.status})`);
        }
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setLogs(data.logs ?? []);
        setTotal(data.total ?? 0);
        setTotalPages(data.totalPages ?? 0);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [page, limit, statusFilter, debouncedSearch]);

  /**
   * Export the current filtered page as a JSON file download.
   * Fetches up to 1000 records (max API limit) for the export.
   */
  const handleExportJSON = useCallback(async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams({
        page: "1",
        limit: "100",
        status: statusFilter,
      });
      if (debouncedSearch) params.set("search", debouncedSearch);

      const res = await fetch(`/api/creator/download-logs?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || body.error || "Export failed");
      }
      const data = await res.json();
      const exportData = {
        exportedAt: new Date().toISOString(),
        filters: { status: statusFilter, search: debouncedSearch || null },
        total: data.total,
        records: data.logs ?? [],
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `eduvault-download-logs-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      // Silently report — the UI doesn't show a full error here to keep export lightweight.
      console.error("[DownloadTable] export failed:", err.message);
    } finally {
      setExporting(false);
    }
  }, [statusFilter, debouncedSearch]);

  const hasFilter = statusFilter !== "all" || debouncedSearch.length > 0;
  const showEmpty = !loading && !error && logs.length === 0;

  return (
    <section aria-labelledby="download-table-heading" className="space-y-4">
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
          {/* Search */}
          <div className="relative flex-1 max-w-sm">
            <FaSearch
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-xs"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchTerm}
              onChange={handleSearchChange}
              placeholder="Search by material name…"
              aria-label="Search download logs by material name"
              className="w-full rounded-xl border border-border-subtle bg-surface-muted py-2.5 pl-9 pr-4 text-sm text-foreground placeholder:text-muted-foreground outline-none transition focus:border-stellar-blue/60 focus:bg-surface-strong focus-visible:ring-2 focus-visible:ring-stellar-blue/30"
            />
          </div>

          {/* Status filter */}
          <div className="relative">
            <FaFilter
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-xs"
              aria-hidden="true"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              aria-label="Filter by download status"
              className="w-full appearance-none rounded-xl border border-border-subtle bg-surface-muted py-2.5 pl-9 pr-8 text-sm text-foreground outline-none transition focus:border-stellar-blue/60 focus:bg-surface-strong focus-visible:ring-2 focus-visible:ring-stellar-blue/30"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Export button */}
        <button
          type="button"
          onClick={handleExportJSON}
          disabled={exporting || loading || logs.length === 0}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-border-subtle bg-surface-strong px-4 py-2.5 text-sm font-semibold text-foreground transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Export download logs as JSON"
        >
          {exporting ? (
            <FaSpinner className="animate-spin" aria-hidden="true" />
          ) : (
            <FaFileExport aria-hidden="true" />
          )}
          Export JSON
        </button>
      </div>

      {/* ── Result summary ───────────────────────────────────────────────── */}
      {!loading && !error && (
        <p className="text-xs text-muted-foreground" aria-live="polite" aria-atomic="true">
          {total === 0
            ? "No results"
            : `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total} record${total !== 1 ? "s" : ""}`}
        </p>
      )}

      {/* ── Error banner ─────────────────────────────────────────────────── */}
      {error && (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          <FaExclamationTriangle className="shrink-0 text-red-500" aria-hidden="true" />
          {error}
          <button
            onClick={() => setPage((p) => p)} // re-trigger the effect
            className="ml-auto text-xs font-semibold underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Table ────────────────────────────────────────────────────────── */}
      <div className="overflow-x-auto rounded-2xl border border-border-subtle bg-surface-strong shadow-sm">
        <table className="w-full min-w-[700px] text-sm" aria-label="Download logs">
          <thead>
            <tr className="border-b border-border-subtle text-left">
              <th scope="col" className="px-5 py-3.5 font-semibold text-muted-foreground whitespace-nowrap">
                Date
              </th>
              <th scope="col" className="px-5 py-3.5 font-semibold text-muted-foreground whitespace-nowrap">
                Material Name
              </th>
              <th scope="col" className="px-5 py-3.5 font-semibold text-muted-foreground whitespace-nowrap">
                Buyer
              </th>
              <th scope="col" className="px-5 py-3.5 font-semibold text-muted-foreground whitespace-nowrap">
                Country
              </th>
              <th scope="col" className="px-5 py-3.5 text-right font-semibold text-muted-foreground whitespace-nowrap">
                Status
              </th>
            </tr>
          </thead>

          <tbody className="divide-y divide-border-subtle">
            {loading &&
              Array.from({ length: limit > 10 ? 8 : 5 }).map((_, i) => (
                <SkeletonRow key={i} />
              ))}

            {!loading && showEmpty && <EmptyState hasFilter={hasFilter} />}

            {!loading &&
              !error &&
              logs.map((log) => (
                <tr
                  key={log.id}
                  className="transition-colors hover:bg-surface-muted"
                >
                  <td className="px-5 py-4 text-muted-foreground whitespace-nowrap">
                    {formatDate(log.date)}
                  </td>
                  <td className="px-5 py-4">
                    <span className="block max-w-[240px] truncate font-medium text-foreground" title={log.materialName}>
                      {log.materialName}
                    </span>
                    {log.category && (
                      <span className="mt-0.5 block text-xs text-muted-foreground capitalize">
                        {log.category}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-4">
                    <span
                      className="font-mono text-xs text-muted-foreground"
                      title={log.buyerAddress}
                    >
                      {truncateAddress(log.buyerAddress)}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-muted-foreground">
                    {log.buyerCountry}
                  </td>
                  <td className="px-5 py-4 text-right">
                    <StatusBadge status={log.downloadStatus} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ───────────────────────────────────────────────────── */}
      {totalPages > 1 && (
        <nav
          aria-label="Download logs pagination"
          className="flex flex-col items-center gap-3 sm:flex-row sm:justify-between"
        >
          <div className="flex items-center gap-2">
            <label htmlFor="page-size-select" className="text-xs text-muted-foreground">
              Rows per page:
            </label>
            <select
              id="page-size-select"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="rounded-lg border border-border-subtle bg-surface-muted px-2 py-1 text-xs text-foreground outline-none focus:border-stellar-blue/60"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1 || loading}
              aria-label="Previous page"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-subtle bg-surface-strong text-muted-foreground transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              <FaChevronLeft className="text-xs" aria-hidden="true" />
            </button>

            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(
                (p) =>
                  p === 1 ||
                  p === totalPages ||
                  Math.abs(p - page) <= 1
              )
              .reduce((acc, p, idx, arr) => {
                if (idx > 0 && p - arr[idx - 1] > 1) {
                  acc.push("…");
                }
                acc.push(p);
                return acc;
              }, [])
              .map((item, idx) =>
                item === "…" ? (
                  <span
                    key={`ellipsis-${idx}`}
                    className="px-1 text-xs text-muted-foreground"
                    aria-hidden="true"
                  >
                    …
                  </span>
                ) : (
                  <button
                    key={item}
                    onClick={() => setPage(item)}
                    disabled={loading}
                    aria-label={`Page ${item}`}
                    aria-current={page === item ? "page" : undefined}
                    className={`inline-flex h-8 min-w-8 items-center justify-center rounded-lg border px-2 text-xs font-medium transition disabled:cursor-not-allowed ${
                      page === item
                        ? "border-stellar-blue bg-stellar-blue text-white"
                        : "border-border-subtle bg-surface-strong text-foreground hover:bg-surface-muted"
                    }`}
                  >
                    {item}
                  </button>
                )
              )}

            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages || loading}
              aria-label="Next page"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-subtle bg-surface-strong text-muted-foreground transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              <FaChevronRight className="text-xs" aria-hidden="true" />
            </button>
          </div>
        </nav>
      )}
    </section>
  );
}
