export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { verifyChallenge, cleanupExpiredChallenges } from "@/lib/auth/challenge";
import { normalizeWalletAddress } from "@/lib/api/validation";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { auditLog } from "@/lib/api/audit";
import { generateAccessToken, generateRefreshToken, storeRefreshToken } from "@/lib/auth/tokenService";
import { AppError, renderErrorResponse } from "@/lib/errors";
import { buildWalletLookupQuery, normalizeProfileForSession } from "@/lib/migrations/profileMigration";
import { normalizeSignedPayload } from "@/lib/canonicalization";

export async function POST(request) {
  return withApiHardening(
    request,
    { route: "auth-verify", rateLimit: { limit: 20, windowMs: 60_000 } },
    async () => {
      try {
        const body = await request.json();
        const address = normalizeWalletAddress(body?.address);
        const nonce = typeof body?.nonce === "string" ? body.nonce.trim() : "";
        const signedTransactionXdr = typeof body?.signedTransactionXdr === "string" ? body.signedTransactionXdr.trim() : "";
        const action = typeof body?.action === "string" ? body.action.trim() : "default";
        const origin = typeof body?.origin === "string" ? body.origin.trim() : undefined;
        const network = typeof body?.network === "string" ? body.network.trim() : undefined;
        const contract = typeof body?.contract === "string" ? body.contract.trim() : undefined;

        if (!address || !nonce || !signedTransactionXdr) {
          return renderErrorResponse(new AppError("VALIDATION_FAILED", { details: { reason: "Missing required fields: address, nonce, signedTransactionXdr" } }), { instance: "/api/auth/verify", });
        }

        // Canonicalize the signed payload before verification so equivalent
        // inputs (ordering, whitespace, casing, numeric precision) produce
        // the same representation. Non-canonical input is either normalized
        // or rejected consistently by the normalizer.
        const normalized = normalizeSignedPayload({
          address,
          nonce,
          signedTransactionXdr,
          action,
          origin,
          network,
          contract,
        });

        if (!normalized.ok) {
          auditLog({
            event: "auth_verify_normalization_failed",
            route: "auth/verify",
            method: "POST",
            status: 400,
            reason: normalized.reason,
            address,
          });
          return renderErrorResponse(new AppError("VALIDATION_FAILED", { details: { reason: normalized.reason } }), { instance: "/api/auth/verify",
           });
        }

        const canonical = normalized.canonical;

        const result = await verifyChallenge(canonical.address, canonical.nonce, canonical.signedTransactionXdr, {
          action: canonical.action,
          origin: canonical.origin,
          network: canonical.network,
          contract: canonical.contract,
        });

        if (!result.valid) {
          auditLog({
            event: "auth_verify_failed",
            route: "auth/verify",
            method: "POST",
            status: 401,
            reason: result.reason,
            address: canonical.address,
          });
          return renderErrorResponse(new AppError("AUTH_UNAUTHENTICATED", { details: { reason: result.reason } }), { instance: "/api/auth/verify",
           });
        }

        cleanuqExpiredChallenges().catch(() => {});

        const db = await getDb();
        const users = db.collection("users");
        const rawUser = await users.findOne(buildWalletLookupQuery(canonical.address));
        const user = rawUser ? normalizeProfileForSession(rawUser) : null;

        if (!process.env.JWT_SECRET) {
          return renderErrorResponse(new AppError("INTERNAL", { details: { reason: "Server configuration error" } }), { instance: "/api/auth/verify"  });
        }

        const userId = user?._id?.toString() ?? canonical.address;
        const tokenPayload = {
          sub: userId,
          email: user?.email ?? "",
          name: user?.fullName ?? "",
          walletAddress: canonical.address,
          action: result.sessionContext.action,
        };

        const accessToken = generateAccessToken(tokenPayload);
        const refreshToken = generateRefreshToken();
        const sessionContext = result.sessionContext;
        await storeRefreshToken(userId, refreshToken, sessionContext);

        const isProduction = process.env.NODE_ENV === "production";
        const response = NextResponse.json({
          success: true,
          user: user || null,
          isNewUser: !user,
        });

        response.cookies.set("auth_token", accessToken, {
          httpOnly: true,
          secure: isProduction,
          sameSite: "strict",
          path: "/",
          maxAge: 15 * 60, // 15 minutes
        });

        response.cookies.set("refresh_token", refreshToken, {
          httpOnly: true,
          secure: isProduction,
          sameSite: "strict",
          path: "/api/auth/refresh",
          maxAge: 7 * 24 * 60 * 60, // 7 days
        });

        auditLog({
          event: "auth_verify_success",
          route: "auth/verify",
          method: "POST",
          status: 200,
          address: canonical.address,
          action: result.sessionContext.action,
        });

        return response;
      } catch (error) {
        auditLog({
          event: "auth_verify_error",
          route: "auth/verify",
          method: "POST",
          status: 500,
          reason: error.message,
        });
        return renderErrorResponse(new AppError("INTERNAL", { details: { reason: "An unexpected error occurred." } }), { instance: "/api/auth/verify"  });
      }
    }
  );
}
