import Navbar from "@/components/Navbar";

export default function Loading() {
  return (
    <>
      <Navbar />
      <main className="relative bg-background min-h-screen py-6 sm:py-10 px-4 sm:px-6 md:px-10 lg:px-20">
        <div className="max-w-6xl mx-auto animate-pulse">
          <div className="mb-6">
            <div className="h-4 w-48 bg-gray-200 dark:bg-surface-muted rounded" />
          </div>
          <div className="mb-6 sm:mb-8">
            <div className="h-8 w-3/4 bg-gray-200 dark:bg-surface-muted rounded-lg" />
            <div className="mt-3 h-4 w-1/3 bg-gray-100 dark:bg-surface-muted rounded" />
            <div className="mt-3 h-4 w-full bg-gray-100 dark:bg-surface-muted rounded" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6 lg:gap-8">
            <div className="space-y-6 lg:space-y-8">
              <div className="h-56 sm:h-72 md:h-[380px] bg-gray-200 dark:bg-surface-muted rounded-2xl" />
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="h-20 bg-gray-100 dark:bg-surface-muted rounded-2xl" />
                ))}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 lg:gap-6">
                <div className="h-40 bg-gray-100 dark:bg-surface-muted rounded-2xl" />
                <div className="h-40 bg-gray-100 dark:bg-surface-muted rounded-2xl" />
              </div>
            </div>
            <div className="h-96 bg-gray-200 dark:bg-surface-muted rounded-3xl" />
          </div>
        </div>
      </main>
    </>
  );
}
