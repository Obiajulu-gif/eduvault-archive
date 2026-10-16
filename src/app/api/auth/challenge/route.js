export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { issueChallenge } from "@/lib/auth/challenge";
import { normalizeWalletAddress } from "@/lib/api/validation";
import { withApiHardening } from "@/lib/api/hardening";
import { canonicalizeChallengeParams } from "@/lib/auth/canonicalization";

export async function GET(request) {
  return withApiHardening(
    request,
    { route: "auth-challenge", rateLimit: { limit: 20, windowMs: 60_000 } },
    async () => {
      try {
        const { searchParams } = new URL(request.url);
        const address = normalizeWalletAddress(searchParams.get("address"));

        if (!address) {
          return NextResponse.json({ error: "Missing or invalid address" }, { status: 400 });
        }

        const normalized = canonicalizeChallengeParams({
          address,
          action: searchParams.get("action"),
          origin: searchParams.get("origin"),
          network: searchParams.get("network"),
          contract: searchParams.get("contract"),
        });

        if (!normalized.ok) {
          return NextResponse.json(
            { error: normalized.error },
            { status: 400 }
          );
        }

        const challenge = await issueChallenge(normalized.address, {
          action: normalized.action,
          origin: normalized.origin,
          network: normalized.network,
          contract: normalized.contract,
          canonical: normalized.canonical,
        });
        return NextResponse.json(challenge);
      } catch (error) {
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
