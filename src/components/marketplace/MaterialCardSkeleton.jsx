export default function MaterialCardSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden shadow-sm animate-pulse flex flex-col"
      data-testid="material-card-skeleton"
    >
      <div className="w-full h-36 bg-gray-200 dark:bg-gray-800" />

      <div className="p-4 flex-1 flex flex-col gap-2">
        <div className="h-4 w-4/5 bg-gray-200 dark:bg-gray-800 rounded" />
        <div className="h-3 w-2/5 bg-gray-100 dark:bg-gray-800/70 rounded" />
        <div className="h-3 w-full bg-gray-100 dark:bg-gray-800/70 rounded" />
        <div className="h-3 w-3/5 bg-gray-100 dark:bg-gray-800/70 rounded" />

        <div className="mt-auto pt-3 border-t border-gray-100 dark:border-gray-800 space-y-3">
          <div className="flex justify-between items-center">
            <div className="h-4 w-14 bg-gray-100 dark:bg-gray-800/70 rounded" />
            <div className="h-6 w-16 bg-gray-100 dark:bg-gray-800/70 rounded-lg" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="h-8 bg-gray-100 dark:bg-gray-800/70 rounded-lg" />
            <div className="h-8 bg-gray-100 dark:bg-gray-800/70 rounded-lg" />
          </div>
        </div>
      </div>
    </div>
  );
}
