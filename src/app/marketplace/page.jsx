import { Suspense } from "react";
import { Navbar } from "@/components/Navbar";
import { ScrollToTop } from "@/components/ScrollToTop";
import { MarketplaceContent } from "@/components/marketplace/MarketplaceContent";

// Enable ISR with 60-second revalidation
export const revalidate = 60;

// Allow static generation with different search parameter combinations
// But limit to prevent unbounded cache entries for free-text search
export async function generateStaticParams() {
  // Generate static versions for common filter combinations only
  // Exclude search params to prevent unbounded cache entries
  return [
    {}, // Base marketplace page
    { subject: "mathematics" },
    { subject: "science" }, 
    { subject: "technology" },
    { subject: "business" },
    { sortBy: "newest" },
    { sortBy: "popular" },
  ];
}

export default function MarketplacePage() {
  return (
    <>
      <Navbar />
      
      <section className="flex flex-col lg:flex-row min-h-screen bg-background">
        <Suspense fallback={<MarketplaceLoadingSkeleton />}>
          <MarketplaceContent />
        </Suspense>
      </section>

      <ScrollToTop />
    </>
  );
}

function MarketplaceLoadingSkeleton() {
  return (
    <>
      {/* Sidebar skeleton */}
      <aside className="w-full lg:w-80 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800">
        <div className="p-4 md:p-6 space-y-6">
          <div className="space-y-4">
            <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse"></div>
            <div className="h-10 bg-gray-200 dark:bg-gray-700 rounded animate-pulse"></div>
          </div>
          
          <div className="space-y-4">
            <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse"></div>
            <div className="grid grid-cols-2 gap-2">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="h-8 bg-gray-200 dark:bg-gray-700 rounded animate-pulse"></div>
              ))}
            </div>
          </div>
        </div>
      </aside>

      {/* Main content skeleton */}
      <main className="flex-1 px-4 md:px-8 py-8 md:py-10">
        {/* Hero skeleton */}
        <div className="bg-gray-100 dark:bg-gray-800 rounded-2xl p-6 mb-8">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded animate-pulse mb-2"></div>
          <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse mb-4"></div>
          <div className="h-10 w-32 bg-gray-200 dark:bg-gray-700 rounded animate-pulse"></div>
        </div>

        {/* Grid skeleton */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[...Array(12)].map((_, i) => (
            <div key={i} className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
              <div className="aspect-video bg-gray-200 dark:bg-gray-700 rounded animate-pulse mb-4"></div>
              <div className="space-y-2">
                <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse"></div>
                <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse w-3/4"></div>
                <div className="h-6 bg-gray-200 dark:bg-gray-700 rounded animate-pulse w-1/2"></div>
              </div>
            </div>
          ))}
        </div>
      </main>
    </>
  );
}
