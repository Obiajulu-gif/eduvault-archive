export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  rotateRefreshToken,
  generateAccessToken,
  cleanupExpiredRefreshTokens,
} from "@/lib/auth/tokenService";
import { getDb } from "@/lib/mongodb";
import { ObjectId } from "mongodb";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";

function getRefreshTokenFromCookie(request) {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/refresh_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function POST(request) {
  return withApiHardening(
    request,
    { route: "auth-refresh", rateLimit: { limit: 10, windowMs: 60_000 } },
    async () => {
      try {
        const oldRefreshToken = getRefreshTokenFromCookie(request);

        if (!oldRefreshToken) {
          auditLog({ event: "token_refresh_missing", route: "auth/refresh", method: "POST", status: 401 });
          return NextResponse.json({ error: "No refresh token" }, { status: 401 });
        }

        let body = {};
        try {
          body = await request.json();
        } catch {
          // Request body optional; may only have cookie token
        }

        const requestedAction = typeof body?.action === "string" ? body.action.trim() : "default";
        const rotation = await rotateRefreshToken(oldRefreshToken, { action: requestedAction });

        if (!rotation) {
          auditLog({ event: "token_refresh_invalid", route: "auth/refresh", method: "POST", status: 401 });
          // Clear any stale cookies on the client
          const response = NextResponse.json({ error: "Invalid or expired refresh token" }, { status: 401 });
          response.cookies.set("auth_token", "", { maxAge: 0, path: "/" });
          response.cookies.set("refresh_token", "", { maxAge: 0, path: "/" });
          return response;
        }

        // Fetch user for the token payload
        const db = await getDb();
        let user = null;
        try {
          user = await db.collection("users").findOne({ _id: new ObjectId(rotation.userId) });
        } catch {
          // userId may not be an ObjectId if originally set to walletAddress
          user = await db.collection("users").findOne({ walletAddress: rotation.userId });
        }

        const tokenPayload = {
          sub: rotation.userId,
          email: user?.email ?? "",
          name: user?.fullName ?? "",
          walletAddress: user?.walletAddress ?? "",
          action: requestedAction,
          sessionFamilyId: rotation.sessionFamilyId,
        };

        const accessToken = generateAccessToken(tokenPayload);

        const isProduction = process.env.NODE_ENV === "production";
        const response = NextResponse.json({ success: true });

        response.cookies.set("auth_token", accessToken, {
          httpOnly: true,
          secure: isProduction,
          sameSite: "strict",
          path: "/",
          maxAge: 15 * 60, // 15 minutes
        });

        response.cookies.set("refresh_token", rotation.refreshToken, {
          httpOnly: true,
          secure: isProduction,
          sameSite: "strict",
          path: "/api/auth/refresh",
          maxAge: 7 * 24 * 60 * 60, // 7 days
        });

        auditLog({
          event: "token_refresh_success",
          route: "auth/refresh",
          method: "POST",
          status: 200,
          actor: rotation.userId,
          action: requestedAction,
          sessionFamilyId: rotation.sessionFamilyId,
        });

        // Opportunistically clean up expired tokens
        cleanupExpiredRefreshTokens().catch(() => {});

        return response;
      } catch (error) {
        auditLog({
          event: "token_refresh_error",
          route: "auth/refresh",
          method: "POST",
          status: 500,
          reason: error.message,
        });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
