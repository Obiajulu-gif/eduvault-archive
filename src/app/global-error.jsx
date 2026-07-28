"use client";

import ErrorFallback from "@/components/common/ErrorFallback";

/**
 * Last-resort boundary for failures in the root layout itself. Next requires
 * this component to render its own <html>/<body> because the layout that
 * normally provides them has crashed.
 */
export default function GlobalError({ error, reset }) {
  return (
    <html lang="en">
      <body>
        <ErrorFallback
          error={error}
          reset={reset}
          title="EduVault hit an unexpected error"
          description="The application shell failed to load. Please try again."
        />
      </body>
    </html>
  );
}
