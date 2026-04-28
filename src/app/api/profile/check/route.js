import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { sanitizeString } from "@/lib/api/validation";
import { getDb } from "@/lib/mongodb";
import { fetchStellarAccountMeta, isValidStellarKey } from "@/lib/stellar/fetchAccountMeta";

/**
 * GET /api/profile/check?publicKey=G...
 * 
 * Public endpoint for account discovery. Checks if a profile exists in MongoDB,
 * and if not, fetches Stellar on-chain metadata.
 * 
 * Response:
 * - exists: true → profile found in DB with sanitized fields
 * - exists: false → returns stellarMeta with on-chain data (if any)
 */
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "profile/check", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      try {
        const { searchParams } = new URL(request.url);
        const publicKey = sanitizeString(searchParams.get("publicKey"), { maxLength: 80 });

        // Validate public key format
        if (!publicKey) {
          return NextResponse.json(
            { error: "Missing publicKey parameter" },
            { status: 400 }
          );
        }

        if (!isValidStellarKey(publicKey)) {
          return NextResponse.json(
            { error: "Invalid Stellar public key" },
            { status: 400 }
          );
        }

        const db = await getDb();
        const users = db.collection("users");

        // Check for existing profile
        const user = await users.findOne({ stellarPublicKey: publicKey });

        if (user) {
          // Profile exists - return sanitized data
          return NextResponse.json({
            exists: true,
            profile: {
              displayName: user.displayName,
              bio: user.bio,
              avatarUrl: user.avatarUrl,
              onboardingComplete: user.onboardingComplete ?? false,
            },
          });
        }

        // No profile in DB - fetch Stellar metadata
        const stellarMeta = await fetchStellarAccountMeta(publicKey);

        return NextResponse.json({
          exists: false,
          stellarMeta: {
            displayName: stellarMeta.displayName,
            bio: stellarMeta.bio,
            avatarUrl: stellarMeta.avatarUrl,
            accountExists: stellarMeta.exists,
          },
        });
      } catch (error) {
        auditLog({
          event: "profile_check_failed",
          route: "profile/check",
          method: "GET",
          status: 500,
          reason: error.message,
        });
        return NextResponse.json(
          { error: "Server error" },
          { status: 500 }
        );
      }
    }
  );
}
