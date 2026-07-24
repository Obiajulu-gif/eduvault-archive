import crypto from "crypto";
import { NextResponse } from "next/server";
import { verifyChallenge, cleanupExpiredChallenges } from "@/lib/auth/challenge";
import { normalizeWalletAddress } from "@/lib/api/validation";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { auditLog } from "@/lib/api/audit";
import { generateAccessToken, generateRefreshToken, storeRefreshToken } from "@/lib/auth/tokenService";
import { errorResponse } from "@/lib/utils/errorResponse";

export const dynamic = "force-dynamic";

function getClientIp(request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

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

        if (!address || !nonce || !signedTransactionXdr) {
          return errorResponse({
            status: 400,
            detail: "Missing required fields: address, nonce, signedTransactionXdr",
            instance: "/api/auth/verify",
          });
        }

        const result = await verifyChallenge(address, nonce, signedTransactionXdr);

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
        const sessionId = crypto.randomUUID();

        const tokenPayload = {
          sub: userId,
          jti: sessionId,
          email: user?.email ?? "",
          name: user?.fullName ?? "",
          walletAddress: address,
        };

        const accessToken = generateAccessToken(tokenPayload);
        const refreshToken = generateRefreshToken();
        await storeRefreshToken(userId, refreshToken, {
          deviceInfo: {
            ip: getClientIp(request),
            userAgent: request.headers.get("user-agent") || "unknown",
            origin: request.headers.get("origin") || null,
          },
        });

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
          maxAge: 15 * 60,
        });

        response.cookies.set("refresh_token", refreshToken, {
          httpOnly: true,
          secure: isProduction,
          sameSite: "strict",
          path: "/api/auth/refresh",
          maxAge: 7 * 24 * 60 * 60,
        });

        auditLog({
          event: "auth_verify_success",
          route: "auth/verify",
          method: "POST",
          status: 200,
          address,
          sessionId,
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
