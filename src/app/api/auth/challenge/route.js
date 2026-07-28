export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { issueChallenge } from "@/lib/auth/challenge";
import { normalizeWalletAddress } from "@/lib/api/validation";
import { withApiHardening } from "@/lib/api/hardening";

export async function GET(request) {
  return withApiHardening(
    request,
    { route: "auth-challenge", rateLimit: { limit: 20, windowMs: 60_000 } },
    async () => {
      try {
        const { searchParams } = new URL(request.url);
        const address = normalizeWalletAddress(searchParams.get("address"));
        const action = searchParams.get("action") || "default";
        const origin = searchParams.get("origin");
        const network = searchParams.get("network");
        const contract = searchParams.get("contract");

        if (!address) {
          return NextResponse.json({ error: "Missing or invalid address" }, { status: 400 });
        }

        const challenge = await issueChallenge(address, {
          action,
          origin,
          network,
          contract,
        });
        return NextResponse.json(challenge);
      } catch (error) {
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
