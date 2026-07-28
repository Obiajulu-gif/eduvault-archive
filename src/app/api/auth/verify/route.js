export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { verifyChallenge, cleanupExpiredChallenges } from "@/lib/auth/challenge";
import { normalizeWalletAddress } from "@/lib/api/validation";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { auditLog } from "@/lib/api/audit";
import { generateAccessToken, generateRefreshToken, storeRefreshToken } from "@/lib/auth/tokenService";
import { errorResponse } from "@/lib/utils/errorResponse";

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
          return errorResponse({
            status: 400,
            detail: "Missing required fields: address, nonce, signedTransactionXdr",
            instance: "/api/auth/verify",
          });
        }

        const result = await verifyChallenge(address, nonce, signedTransactionXdr, {
          action,
          origin,
          network,
          contract,
        });

        if (!result.valid) {
          auditLog({
            event: "auth_verify_failed",
            route: "auth/verify",
            method: "POST",
            status: 401,
            reason: result.reason,
            address,
          });
          return errorResponse({
            status: 401,
            detail: result.reason,
            instance: "/api/auth/verify",
          });
        }

        cleanupExpiredChallenges().catch(() => {});

        const db = await getDb();
        const users = db.collection("users");
        const user = await users.findOne({
          $or: [
            { walletAddress: address },
            { walletAddressLower: address.toLowerCase() },
          ],
        });

        if (!process.env.JWT_SECRET) {
          return errorResponse({ status: 500, detail: "Server configuration error", instance: "/api/auth/verify" });
        }

        const userId = user?._id?.toString() ?? address;
        const tokenPayload = {
          sub: userId,
          email: user?.email ?? "",
          name: user?.fullName ?? "",
          walletAddress: address,
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
          address,
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
        return errorResponse({ status: 500, detail: "An unexpected error occurred.", instance: "/api/auth/verify" });
      }
    }
  );
}
