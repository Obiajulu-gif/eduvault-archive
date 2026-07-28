export function MobileFiltersSkeleton() {
  return (
    <div aria-hidden="true" className="lg:hidden w-full bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
      <div className="overflow-x-auto px-4 py-3 flex gap-2 animate-pulse">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-8 w-20 bg-gray-200 dark:bg-gray-800 rounded-full flex-shrink-0"
          />
        ))}
      </div>
    </div>
  );
}

export function SidebarFiltersSkeleton() {
  return (
    <aside aria-hidden="true" className="hidden lg:block w-72 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 px-6 py-10 sticky top-0 h-screen overflow-y-auto animate-pulse">
      <div className="h-4 w-20 bg-gray-200 dark:bg-gray-800 rounded mb-6" />
      <div className="space-y-3">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-10 w-full bg-gray-100 dark:bg-gray-800/70 rounded-lg" />
        ))}
      </div>

      <div className="mt-8">
        <div className="h-4 w-24 bg-gray-200 dark:bg-gray-800 rounded mb-6" />
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-10 w-full bg-gray-100 dark:bg-gray-800/70 rounded-lg" />
          ))}
        </div>
      </div>
    </aside>
  );
}

export function FilterBarSkeleton() {
  return (
    <div aria-hidden="true" className="bg-white dark:bg-gray-900 p-4 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm mb-8 flex flex-col md:flex-row gap-4 items-center justify-between animate-pulse">
      <div className="h-10 w-full md:max-w-md bg-gray-100 dark:bg-gray-800/70 rounded-lg" />
      <div className="flex items-center gap-3">
        <div className="h-10 w-32 bg-gray-100 dark:bg-gray-800/70 rounded-lg" />
        <div className="h-10 w-28 bg-gray-100 dark:bg-gray-800/70 rounded-lg hidden md:block" />
        <div className="h-10 w-28 bg-gray-100 dark:bg-gray-800/70 rounded-lg" />
      </div>
    </div>
  );
}

export default function MarketplaceFiltersSkeleton() {
  return (
    <>
      <MobileFiltersSkeleton />
      <SidebarFiltersSkeleton />
      <FilterBarSkeleton />
    </>
  );
}