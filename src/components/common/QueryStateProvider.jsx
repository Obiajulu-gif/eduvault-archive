import React from 'react';

/**
 * Loading component for general use
 */
export function LoadingSpinner({ size = 'h-8 w-8', className = '' }) {
  return (
    <div className={`flex items-center justify-center p-12 ${className}`}>
      <div className={`animate-spin rounded-full border-b-2 border-blue-600 ${size}`}></div>
    </div>
  );
}

/**
 * Error message component for general use
 */
export function ErrorMessage({ message, retry, className = '' }) {
  return (
    <div className={`p-8 text-center bg-red-50 rounded-xl border border-red-100 ${className}`}>
      <p className="text-red-600 font-medium">Failed to load data</p>
      <p className="text-red-400 text-sm mt-1">{message || 'Please try again later'}</p>
      {retry && (
        <button 
          onClick={retry}
          className="mt-4 text-sm font-semibold text-red-600 hover:text-red-700 underline"
        >
          Try Again
        </button>
      )}
    </div>
  );
}

/**
 * Empty state component for general use
 */
export function EmptyState({ message = 'No items found', className = '' }) {
  return (
    <div className={`p-12 text-center text-gray-500 bg-gray-50 rounded-xl border border-gray-100 ${className}`}>
      {message}
    </div>
  );
}

/**
 * A reusable wrapper for handling TanStack Query states consistently.
 */
export function QueryStateProvider({ 
  query, 
  children, 
  loadingComponent, 
  errorComponent, 
  emptyComponent,
  renderData 
}) {
  const { data, isLoading, isError, error, refetch } = query;

  if (isLoading) {
    return loadingComponent || <LoadingSpinner />;
  }

  if (isError) {
    return errorComponent || <ErrorMessage message={error?.message} retry={refetch} />;
  }

  const items = data?.items || data;
  const isEmpty = !items || (Array.isArray(items) && items.length === 0);

  if (isEmpty) {
    return emptyComponent || <EmptyState />;
  }

  if (renderData) {
    return renderData(items);
  }

  return typeof children === 'function' ? children(items) : children;
}

