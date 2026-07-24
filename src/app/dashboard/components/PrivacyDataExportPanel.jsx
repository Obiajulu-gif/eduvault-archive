"use client";

import { useState } from "react";
import {
  FaDownload,
  FaCheckCircle,
  FaSpinner,
  FaExclamationTriangle,
  FaFileAlt,
  FaClock,
} from "react-icons/fa";

const STATUS_LABELS = {
  pending:    "Preparing your export…",
  processing: "Collecting your data…",
  ready:      "Your export is ready.",
  expired:    "This export has expired.",
  failed:     "Export failed. Please try again.",
};

export default function PrivacyDataExportPanel() {
  const [state, setState] = useState({
    phase: "idle", // idle | requesting | polling | ready | expired | failed
    requestId: null,
    token: null,
    expiresAt: null,
    error: null,
  });

  async function handleRequestExport() {
    setState((s) => ({ ...s, phase: "requesting", error: null }));
    try {
      const res = await fetch("/api/privacy/export", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Export request failed");

      if (data.status === "ready") {
        setState({
          phase: "ready",
          requestId: data.requestId,
          token: data.token,
          expiresAt: data.expiresAt,
          error: null,
        });
      } else {
        // Poll for completion
        setState({
          phase: "polling",
          requestId: data.requestId,
          token: data.token,
          expiresAt: null,
          error: null,
        });
        pollStatus(data.requestId, data.token);
      }
    } catch (err) {
      setState((s) => ({ ...s, phase: "failed", error: err.message }));
    }
  }

  async function pollStatus(requestId, token) {
    const MAX_POLLS = 20;
    let polls = 0;
    const interval = setInterval(async () => {
      polls++;
      try {
        const res = await fetch(`/api/privacy/export?requestId=${requestId}`);
        const data = await res.json();
        if (data.status === "ready") {
          clearInterval(interval);
          setState({ phase: "ready", requestId, token, expiresAt: data.expiresAt, error: null });
        } else if (data.status === "failed" || data.status === "expired") {
          clearInterval(interval);
          setState({ phase: data.status, requestId, token, expiresAt: null, error: null });
        } else if (polls >= MAX_POLLS) {
          clearInterval(interval);
          setState((s) => ({ ...s, phase: "failed", error: "Export timed out. Please try again." }));
        }
      } catch {
        clearInterval(interval);
        setState((s) => ({ ...s, phase: "failed", error: "Could not check export status." }));
      }
    }, 3000);
  }

  function handleDownload() {
    const { requestId, token } = state;
    window.location.href = `/api/privacy/export/download?requestId=${requestId}&token=${token}`;
  }

  const isLoading = state.phase === "requesting" || state.phase === "polling";

  return (
    <section
      aria-labelledby="export-heading"
      className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900"
    >
      <div className="flex items-start gap-4">
        <div className="rounded-xl bg-blue-50 p-3 dark:bg-blue-950">
          <FaFileAlt className="h-5 w-5 text-blue-600 dark:text-blue-400" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 id="export-heading" className="text-base font-semibold text-gray-900 dark:text-white">
            Download Your Data
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Request a full export of your EduVault data including your profile, purchases, materials,
            saved items, and learning progress. The export is a JSON file available for 48 hours.
          </p>
        </div>
      </div>

      <div className="mt-5">
        {/* Idle / requesting */}
        {(state.phase === "idle" || state.phase === "requesting" || state.phase === "polling") && (
          <button
            onClick={handleRequestExport}
            disabled={isLoading}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            aria-busy={isLoading}
          >
            {isLoading ? (
              <>
                <FaSpinner className="h-4 w-4 animate-spin" aria-hidden="true" />
                {state.phase === "requesting" ? "Requesting…" : "Preparing export…"}
              </>
            ) : (
              <>
                <FaDownload className="h-4 w-4" aria-hidden="true" />
                Request Data Export
              </>
            )}
          </button>
        )}

        {/* Ready */}
        {state.phase === "ready" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
              <FaCheckCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              Your export is ready.
              {state.expiresAt && (
                <span className="ml-1 text-gray-500 dark:text-gray-400">
                  Expires{" "}
                  <time dateTime={state.expiresAt}>
                    {new Date(state.expiresAt).toLocaleString()}
                  </time>
                </span>
              )}
            </div>
            <button
              onClick={handleDownload}
              className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-green-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-600 transition-colors"
            >
              <FaDownload className="h-4 w-4" aria-hidden="true" />
              Download JSON
            </button>
          </div>
        )}

        {/* Expired */}
        {state.phase === "expired" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
              <FaClock className="h-4 w-4 shrink-0" aria-hidden="true" />
              This export has expired. Request a new one.
            </div>
            <button
              onClick={() => setState({ phase: "idle", requestId: null, token: null, expiresAt: null, error: null })}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              Request New Export
            </button>
          </div>
        )}

        {/* Failed */}
        {state.phase === "failed" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-red-700 dark:text-red-400">
              <FaExclamationTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {state.error ?? "Export failed."}
            </div>
            <button
              onClick={() => setState({ phase: "idle", requestId: null, token: null, expiresAt: null, error: null })}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
