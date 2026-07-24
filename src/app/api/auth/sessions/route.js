export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getUserFromCookie } from "@/lib/api/auth";
import { listRefreshTokenSessions, revokeRefreshTokenFamilyByFamilyId } from "@/lib/auth/tokenService";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";

export async function GET(request) {
  return withApiHardening(
    request,
    { route: "auth-sessions", rateLimit: { limit: 20, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user?.sub) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const sessions = await listRefreshTokenSessions(user.sub);
      return NextResponse.json({ sessions });
    }
  );
}

export async function DELETE(request) {
  return withApiHardening(
    request,
    { route: "auth-sessions", rateLimit: { limit: 20, windowMs: 60_000 } },
    async () => {
      const user = await getUserFromCookie(request);
      if (!user?.sub) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const body = await request.json();
      const familyId = typeof body?.familyId === "string" ? body.familyId.trim() : "";

      if (!familyId) {
        return NextResponse.json({ error: "Missing familyId" }, { status: 400 });
      }

      await revokeRefreshTokenFamilyByFamilyId(familyId, user.sub);
      auditLog({
        event: "auth_sessions_revoke",
        route: "auth/sessions",
        method: "DELETE",
        status: 200,
        actor: user.sub,
        familyId,
      });

      return NextResponse.json({ success: true });
    }
  );
}
