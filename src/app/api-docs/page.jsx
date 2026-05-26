"use client";

/**
 * Interactive API documentation page (#83).
 *
 * Renders the OpenAPI spec at /docs/openapi.yaml using swagger-ui-react.
 * Route: /api-docs
 *
 * Install the peer dependency if it is not already present:
 *   npm install swagger-ui-react
 */

import dynamic from "next/dynamic";
import "swagger-ui-react/swagger-ui.css";

// Lazy-load SwaggerUI — it is large and only needed on this page.
const SwaggerUI = dynamic(() => import("swagger-ui-react"), { ssr: false });

export default function ApiDocsPage() {
  return (
    <div style={{ padding: "1rem" }}>
      <SwaggerUI url="/openapi.yaml" docExpansion="list" />
    </div>
  );
}
