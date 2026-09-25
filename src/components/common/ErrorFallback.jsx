"use client";

import Link from "next/link";
import { FaExclamationTriangle } from "react-icons/fa";

/**
 * Shared fallback UI for App Router error boundaries (error.jsx files).
 *
 * Renders the failure reason, a retry button wired to Next's `reset`, and a
 * link back home so users are never stuck on a dead screen after an API or
 * IPFS failure.
 */
export default function ErrorFallback({
  error,
  reset,
  title = "Something went wrong",
  description = "An unexpected error occurred while loading this page. Please try again.",
}) {
  return (
    <main className="min-h-screen bg-[#fffaf6] flex items-center justify-center px-4">
      <div className="max-w-lg w-full text-center py-20">
        <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-red-50 text-red-500 mb-6">
          <FaExclamationTriangle className="h-8 w-8" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">{title}</h1>
        <p className="text-gray-500 leading-relaxed mb-2">{description}</p>
        {error?.message && (
          <p className="text-xs text-gray-400 mb-8 break-words" data-testid="error-detail">
            {error.message}
          </p>
        )}
        <div className="flex items-center justify-center gap-3">
          {typeof reset === "function" && (
            <button
              type="button"
              onClick={reset}
              className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl transition focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              Try again
            </button>
          )}
          <Link
            href="/"
            className="px-6 py-2.5 border border-gray-300 hover:bg-gray-50 text-gray-700 font-semibold rounded-xl transition focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Go home
          </Link>
        </div>
      </div>
    </main>
  );
}
