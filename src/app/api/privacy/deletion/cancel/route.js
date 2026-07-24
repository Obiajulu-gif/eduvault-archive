export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiHardening } from "@/lib/api/hardening";
import { getUserFromCookie } from "@/lib/api/auth";
import { cancelDeletionRequest } from "@/lib/privacy/deletionStateMachine";

/**
 * POST /api/privacy/deletion/cancel
 * Body: { requestId: string, reason?: string }
 */
export async function POST(request) {
  return withApiHardening(
    request,
    { route: "privacy_deletion_cancel", rateLimit: { limit: 10, windowMs: 60 * 60 * 1000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

      const userId = user.sub ?? user._id;
      let body;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const { requestId, reason } = body ?? {};
      if (!requestId) return NextResponse.json({ error: "Missing requestId" }, { status: 400 });

      try {
        const result = await cancelDeletionRequest(requestId, String(userId), reason ?? null);
        return NextResponse.json(result);
      } catch (err) {
        const status =
          err.code === "forbidden"          ? 403 :
          err.code === "invalid_transition" ? 409 : 500;
        return NextResponse.json({ error: err.message }, { status });
      }
    }
  );
}
