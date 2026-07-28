"use client";

import ErrorFallback from "@/components/common/ErrorFallback";

/**
 * Root-segment error boundary. Catches render/data errors from any page that
 * does not define its own error.jsx, so API failures degrade to a recoverable
 * screen instead of Next's unstyled default overlay.
 */
export default function Error({ error, reset }) {
  return <ErrorFallback error={error} reset={reset} />;
}
