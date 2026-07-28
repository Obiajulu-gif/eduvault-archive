"use client";

import { FaExclamationTriangle } from "react-icons/fa";
import Navbar from "@/components/Navbar";

export default function Error({ error, reset }) {
  return (
    <>
      <Navbar />
      <main className="relative bg-background min-h-screen py-6 sm:py-10 px-4 sm:px-6 md:px-10 lg:px-20">
        <div className="max-w-lg mx-auto text-center py-20">
          <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-red-50 dark:bg-red-900/30 text-red-500 dark:text-red-400 mb-6">
            <FaExclamationTriangle className="h-8 w-8" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-foreground mb-2">Failed to load material</h1>
          <p className="text-gray-500 dark:text-muted-foreground leading-relaxed mb-8">
            {error?.message || "Something went wrong while loading this material. Please try again."}
          </p>
          <button
            type="button"
            onClick={reset}
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 text-white font-semibold rounded-xl transition focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Try again
          </button>
        </div>
      </main>
    </>
  );
}
