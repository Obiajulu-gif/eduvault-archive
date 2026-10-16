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

// Inline loading skeleton for the Suspense fallback. Mirrors the
// MarketplaceContent layout (filter sidebar + results grid) so the page
// doesn't jump when the content resolves.
function MarketplaceLoadingSkeleton() {
  return (
    <div className="flex flex-col lg:flex-row gap-8 p-6" aria-hidden="true">
      <div className="lg:w-64 flex-shrink-0 space-y-4">
        <div className="h-6 w-32 animate-pulse rounded bg-gray-200" />
        <div className="h-24 w-full animate-pulse rounded bg-gray-200" />
        <div className="h-24 w-full animate-pulse rounded bg-gray-200" />
      </div>
      <div className="flex-1">
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-64 animate-pulse rounded-xl bg-gray-200" />
          ))}
        </div>
      </div>
    </div>
  );
}
