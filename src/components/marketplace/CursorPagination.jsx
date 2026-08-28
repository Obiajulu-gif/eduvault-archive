import { useRef, useEffect } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';

/**
 * Cursor-based pagination component for improved performance on large datasets
 * Uses base64-encoded cursors instead of page numbers
 */
export default function CursorPagination({
  hasNextPage,
  hasPreviousPage = false,
  nextCursor,
  previousCursor,
  isLoading = false,
  onNext,
  onPrevious,
  className = ''
}) {
  const handleNext = () => {
    if (hasNextPage && !isLoading && onNext) {
      onNext(nextCursor);
    }
  };

  const handlePrevious = () => {
    if (hasPreviousPage && !isLoading && onPrevious) {
      onPrevious(previousCursor);
    }
  };

  return (
    <div className={`flex items-center justify-center space-x-4 ${className}`}>
      <button
        onClick={handlePrevious}
        disabled={!hasPreviousPage || isLoading}
        className={`
          flex items-center px-4 py-2 text-sm font-medium rounded-lg transition-colors
          ${hasPreviousPage && !isLoading
            ? 'text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
            : 'text-gray-400 dark:text-gray-600 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 cursor-not-allowed'
          }
        `}
        aria-label="Previous page"
      >
        <ChevronLeftIcon className="h-4 w-4 mr-1" />
        Previous
      </button>

      {isLoading && (
        <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
          <div className="animate-spin h-4 w-4 border-2 border-blue-500 border-t-transparent rounded-full mr-2"></div>
          Loading...
        </div>
      )}

      <button
        onClick={handleNext}
        disabled={!hasNextPage || isLoading}
        className={`
          flex items-center px-4 py-2 text-sm font-medium rounded-lg transition-colors
          ${hasNextPage && !isLoading
            ? 'text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
            : 'text-gray-400 dark:text-gray-600 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 cursor-not-allowed'
          }
        `}
        aria-label="Next page"
      >
        Next
        <ChevronRightIcon className="h-4 w-4 ml-1" />
      </button>
    </div>
  );
}

/**
 * Infinite scroll component for cursor-based pagination
 * Automatically loads more content as user scrolls
 */
export function InfiniteScrollLoader({
  hasNextPage,
  isLoading,
  onLoadMore,
  className = '',
  children
}) {
  const loadMoreRef = useRef();

  useEffect(() => {
    if (!hasNextPage || isLoading) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && onLoadMore) {
          onLoadMore();
        }
      },
      { threshold: 0.1 }
    );

    if (loadMoreRef.current) {
      observer.observe(loadMoreRef.current);
    }

    return () => observer.disconnect();
  }, [hasNextPage, isLoading, onLoadMore]);

  return (
    <>
      {children}
      <div 
        ref={loadMoreRef}
        className={`flex items-center justify-center py-8 ${className}`}
      >
        {hasNextPage && (
          <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
            {isLoading ? (
              <>
                <div className="animate-spin h-4 w-4 border-2 border-blue-500 border-t-transparent rounded-full mr-2"></div>
                Loading more materials...
              </>
            ) : (
              <div className="text-center">
                <div className="text-gray-400 dark:text-gray-600">Scroll to load more</div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}