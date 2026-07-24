export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import crypto from "crypto";
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
      const oldRefreshToken = getRefreshTokenFromCookie(request);

      if (!oldRefreshToken) {
        auditLog({ event: "token_refresh_missing", route: "auth/refresh", method: "POST", status: 401 });
        return NextResponse.json({ error: "No refresh token" }, { status: 401 });
      }

      const rotation = await rotateRefreshToken(oldRefreshToken);

      if (!rotation) {
        auditLog({ event: "token_refresh_invalid", route: "auth/refresh", method: "POST", status: 401 });
        const response = NextResponse.json({ error: "Invalid or expired refresh token" }, { status: 401 });
        response.cookies.set("auth_token", "", { maxAge: 0, path: "/" });
        response.cookies.set("refresh_token", "", { maxAge: 0, path: "/api/auth/refresh" });
        return response;
      }

      const db = await getDb();
      let user = null;
      try {
        user = await db.collection("users").findOne({ _id: new ObjectId(rotation.userId) });
      } catch {
        user = await db.collection("users").findOne({ walletAddress: rotation.userId });
      }

      const tokenPayload = {
        sub: rotation.userId,
        jti: crypto.randomUUID(),
        email: user?.email ?? "",
        name: user?.fullName ?? "",
        walletAddress: user?.walletAddress ?? "",
      };

      const accessToken = generateAccessToken(tokenPayload);

      const isProduction = process.env.NODE_ENV === "production";
      const response = NextResponse.json({ success: true });

      response.cookies.set("auth_token", accessToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: "strict",
        path: "/",
        maxAge: 15 * 60,
      });

      response.cookies.set("refresh_token", rotation.refreshToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: "strict",
        path: "/api/auth/refresh",
        maxAge: 7 * 24 * 60 * 60,
      });

      auditLog({ event: "token_refresh_success", route: "auth/refresh", method: "POST", status: 200, actor: rotation.userId, familyId: rotation.familyId });

      cleanupExpiredRefreshTokens().catch(() => {});

      return response;
    }
  );
}
