export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireActiveUser } from "@/lib/api/auth";

/**
 * GET /api/auth/session
 *
 * Lightweight session-expiry check for the client. `auth_token` is httpOnly
 * so the browser can't read its `exp` claim directly — this endpoint verifies
 * the cookie server-side and hands back just the expiry timestamp, which the
 * session-timeout countdown (SessionWarning) uses to schedule its warning.
 */
export async function GET(request) {
  const result = await requireActiveUser(request);

  if (!result.ok || typeof result.user.exp !== "number") {
    return NextResponse.json({ authenticated: false }, { status: result.status || 401 });
  }

  return NextResponse.json({
    authenticated: true,
    expiresAt: result.user.exp * 1000,
    role: result.user.role || null,
  });
}
