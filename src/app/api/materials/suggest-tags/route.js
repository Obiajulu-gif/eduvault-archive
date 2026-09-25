export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { getUserFromCookie } from "@/lib/api/auth";
import { ValidationError } from "@/lib/api/validation";
import { suggestTags } from "@/lib/utils/tagExtractor";

export const runtime = "nodejs";

export async function POST(request) {
  return withApiHardening(
    request,
    { route: "suggest-tags", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user) {
        auditLog({ event: "auth_failed", route: "suggest-tags", method: "POST", status: 401 });
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      let body;
      try {
        body = await request.json();
      } catch (e) {
        throw new ValidationError("Invalid JSON payload");
      }

      const title = body?.title;
      const description = body?.description;

      if ((title === undefined || title === null) && (description === undefined || description === null)) {
        throw new ValidationError("At least one of title or description must be provided");
      }

      if (title !== undefined && title !== null && typeof title !== "string") {
        throw new ValidationError("Title must be a string");
      }

      if (description !== undefined && description !== null && typeof description !== "string") {
        throw new ValidationError("Description must be a string");
      }

      const result = suggestTags(title || "", description || "");

      auditLog({
        event: "tags_suggested",
        route: "suggest-tags",
        method: "POST",
        status: 200,
        actor: user.sub,
        durationMs: result.durationMs
      });

      return NextResponse.json({
        success: true,
        tags: result.tags,
        durationMs: result.durationMs
      });
    }
  );
}
