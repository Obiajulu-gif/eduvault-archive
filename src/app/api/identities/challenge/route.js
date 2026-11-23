export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createIdentityLinkChallenge } from "@/lib/auth/identityLinks";
import { handleIdentityRoute } from "../identityRoute";

/**
 * POST /api/identities/challenge — `{ provider: "stellar", subject: "G..." }`.
 * Returns the message the identity's wallet must sign with SEP-53
 * `signMessage` before it expires.
 */
export async function POST(request) {
  return handleIdentityRoute(request, { route: "identities-challenge", rateLimit: { limit: 10, windowMs: 60_000 } }, async ({ db, user }) => {
    const body = await request.json().catch(() => ({}));
    const challenge = await createIdentityLinkChallenge({ db, user, provider: body?.provider, subject: body?.subject });
    return NextResponse.json(challenge, { status: 201 });
  });
}
