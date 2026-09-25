"use client";

import Link from "next/link";
import { FaBookOpen } from "react-icons/fa";

/**
 * Terminal state for a material that does not exist (bad link, deleted, or
 * private). Unlike transient API failures, retrying cannot help here, so the
 * page offers a way back to the marketplace instead of a retry button.
 */
export default function MaterialNotFound() {
  return (
    <div className="max-w-lg mx-auto text-center py-20" data-testid="material-not-found">
      <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-blue-50 text-blue-500 mb-6">
        <FaBookOpen className="h-8 w-8" aria-hidden="true" />
      </div>
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Material not found</h1>
      <p className="text-gray-500 leading-relaxed mb-8">
        This material may have been removed, made private, or the link is incorrect.
      </p>
      <Link
        href="/marketplace"
        className="inline-block px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl transition focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        Browse the marketplace
      </Link>
    </div>
  );
}
