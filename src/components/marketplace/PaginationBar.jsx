export default function PaginationBar({ currentPage, totalPages, onPageChange }) {
  if (totalPages <= 1) return null;

  return (
    <nav aria-label="Pagination">
      <div className="flex justify-center mt-8 gap-2">
        {Array.from({ length: totalPages }).map((_, i) => (
          <button
            key={i}
            onClick={() => onPageChange(i + 1)}
            aria-current={currentPage === i + 1 ? "page" : undefined}
            className={`px-3 py-1.5 rounded focus-visible:ring-2 focus-visible:ring-blue-500 ${
              currentPage === i + 1
                ? "bg-blue-600 text-white"
                : "bg-gray-100 dark:bg-surface-muted text-gray-700 dark:text-foreground/80 hover:bg-gray-200 dark:hover:bg-surface-strong"
            }`}
          >
            {i + 1}
          </button>
        ))}
      </div>
    </nav>
  );
}
