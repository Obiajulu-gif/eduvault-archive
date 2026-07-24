export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { toPrometheusFormat } from "@/lib/telemetry/metrics";

/**
 * Prometheus-compatible metrics endpoint (#20).
 *
 * Not wrapped in withApiHardening intentionally — scrapers hit this on a
 * tight interval and shouldn't be subject to the same per-user rate limits
 * as user-facing routes. If this is exposed publicly in production, put it
 * behind network-level access control (VPC/allowlist) rather than app auth,
 * which is standard practice for metrics scrape endpoints.
 */
export async function GET() {
  const body = toPrometheusFormat();
  return new NextResponse(body, {
    status: 200,
    headers: { "content-type": "text/plain; version=0.0.4" },
  });
}