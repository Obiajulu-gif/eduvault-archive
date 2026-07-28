"use client";

import { FaDownload } from "react-icons/fa";
import DownloadTable from "@/components/dashboard/DownloadTable";

/**
 * Download Logs page — /dashboard/analytics/downloads
 *
 * Displays a paginated, filterable table of download events for the
 * authenticated creator's materials. Includes a JSON export option.
 */
export default function DownloadLogsPage() {
  return (
    <div className="space-y-8">
      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-stellar-blue/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-stellar-blue">
            <FaDownload aria-hidden="true" />
            Creator analytics
          </div>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-foreground">
            Download Logs
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Track every download event across your materials. Filter by status,
            search by name, and export records in JSON format.
          </p>
        </div>
      </div>

      {/* Table */}
      <DownloadTable />
    </div>
  );
}
