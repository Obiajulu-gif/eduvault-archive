export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { auditLog } from "@/lib/api/audit";
import { getTaxonomy, getSubjectsByCategory } from "@/lib/backend/taxonomy";

// Taxonomy is static, public reference data (no buyer/session-specific fields),
// so it's safe to cache publicly. stale-while-revalidate=86400 means a newly
// added subject can take up to a day to show everywhere; that's an accepted
// tradeoff per docs/tasks/marketplace-performance-audit.md rather than
// building a dedicated cache-busting endpoint for this low-churn data.
const CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";

// GET /api/subjects
// Returns canonical taxonomy data (categories, subjects, levels)
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "subjects", rateLimit: { limit: 100, windowMs: 60_000 } },
    async () => {
      try {
        const url = new URL(request.url);
        const categoryId = url.searchParams.get("category");

        if (categoryId) {
          const subjects = getSubjectsByCategory(categoryId);
          return NextResponse.json(
            { subjects, categoryId },
            { headers: { "Cache-Control": CACHE_CONTROL } }
          );
        }

        return NextResponse.json(getTaxonomy(), {
          headers: { "Cache-Control": CACHE_CONTROL },
        });
      } catch (error) {
        auditLog({ event: "subjects_list_failed", route: "subjects", method: "GET", status: 500, reason: error.message });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
