export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { unlinkIdentity } from "@/lib/auth/identityLinks";
import { handleIdentityRoute } from "../identityRoute";

/**
 * DELETE /api/identities/:linkId — unlink one of the caller's identities.
 * Every other session is revoked; the current session family is kept.
 */
export async function DELETE(request, { params }) {
  return handleIdentityRoute(request, { route: "identities-unlink", rateLimit: { limit: 10, windowMs: 60_000 } }, async ({ db, user }) => {
    const { linkId } = await params;
    const result = await unlinkIdentity({ db, user, linkId, sessionFamilyId: user.sessionFamilyId ?? null });
    return NextResponse.json(result);
  });
}
