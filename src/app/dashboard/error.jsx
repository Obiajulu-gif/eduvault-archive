"use client";

import { FaExclamationTriangle } from "react-icons/fa";

export default function Error({ error, reset }) {
  return (
    <div className="flex items-center justify-center py-24">
      <div className="max-w-lg text-center">
        <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-red-50 dark:bg-red-950/40 text-red-500 dark:text-red-400 mb-6">
          <FaExclamationTriangle className="h-8 w-8" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-50 mb-2">Failed to load dashboard</h1>
        <p className="text-gray-500 dark:text-gray-400 leading-relaxed mb-8">
          {error?.message || "Something went wrong while loading this section of your dashboard."}
        </p>
        <button
          type="button"
          onClick={reset}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl transition focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
