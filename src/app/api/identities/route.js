export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { confirmIdentityLink, listIdentityLinks } from "@/lib/auth/identityLinks";
import { handleIdentityRoute } from "./identityRoute";

/** GET /api/identities — the caller's active external identity links. */
export async function GET(request) {
  return handleIdentityRoute(request, { route: "identities-list", rateLimit: { limit: 60, windowMs: 60_000 } }, async ({ db, user }) =>
    NextResponse.json({ links: await listIdentityLinks({ db, user }) })
  );
}

/**
 * POST /api/identities — complete a link by submitting the SEP-53 signature
 * of the challenge message: `{ challengeId, signature }`.
 */
export async function POST(request) {
  return handleIdentityRoute(request, { route: "identities-link", rateLimit: { limit: 10, windowMs: 60_000 } }, async ({ db, user }) => {
    const body = await request.json().catch(() => ({}));
    const link = await confirmIdentityLink({ db, user, challengeId: body?.challengeId, signature: body?.signature });
    return NextResponse.json({ link }, { status: 201 });
  });
}
