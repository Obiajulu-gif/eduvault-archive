"use client";

import { FaExclamationTriangle, FaRedo, FaBug } from "react-icons/fa";

export function ErrorBoundaryFallback({
  error,
  onRetry,
  title = "Something went wrong",
  description = "An unexpected error occurred in this section. Please try again or report the issue.",
}) {
  const handleReport = () => {
    const issueBody = [
      "**Error description:**",
      error?.message || "Unknown error",
      "",
      "**Steps to reproduce:**",
      "1. ",
      "",
      "**Environment:**",
      `- User Agent: ${navigator.userAgent}`,
      `- URL: ${window.location.href}`,
    ].join("\n");

    window.open(
      `https://github.com/oraimoitel/eduvault-archive/issues/new?title=${encodeURIComponent("[Error]: " + (error?.message || "Unknown"))}&body=${encodeURIComponent(issueBody)}`,
      "_blank",
    );
  };

  return (
    <div
      role="alert"
      className="flex items-center justify-center p-8"
    >
      <div className="max-w-md w-full text-center">
        <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-red-50 dark:bg-red-950/40 text-red-500 dark:text-red-400 mb-6">
          <FaExclamationTriangle className="h-8 w-8" />
        </div>

        <h2 className="text-xl font-bold text-gray-900 dark:text-gray-50 mb-2">
          {title}
        </h2>

        <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed mb-6">
          {description}
        </p>

        {error?.message && (
          <div className="mb-6 rounded-xl bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-4 text-left">
            <p className="text-xs font-mono text-red-600 dark:text-red-400 break-words">
              {error.message}
            </p>
          </div>
        )}

        <div className="bg-gray-50 dark:bg-gray-900 rounded-xl p-5 mb-6 text-left">
          <h3 className="text-xs font-bold text-gray-700 dark:text-gray-300 uppercase tracking-wider mb-3">
            Troubleshooting steps
          </h3>
          <ol className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
            <li className="flex items-start gap-2">
              <span className="font-bold text-gray-400 dark:text-gray-500 shrink-0">1.</span>
              <span>Refresh the page and try again</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="font-bold text-gray-400 dark:text-gray-500 shrink-0">2.</span>
              <span>Clear your browser cache and reload</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="font-bold text-gray-400 dark:text-gray-500 shrink-0">3.</span>
              <span>Ensure your wallet is connected and on the correct network</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="font-bold text-gray-400 dark:text-gray-500 shrink-0">4.</span>
              <span>If the problem persists, report the issue below</span>
            </li>
          </ol>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center justify-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl transition focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <FaRedo className="w-4 h-4" />
            Try again
          </button>

          <button
            type="button"
            onClick={handleReport}
            className="inline-flex items-center justify-center gap-2 px-6 py-2.5 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 font-semibold rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800 transition focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <FaBug className="w-4 h-4" />
            Report issue
          </button>
        </div>
      </div>
    </div>
  );
}