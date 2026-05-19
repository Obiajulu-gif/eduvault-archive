import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";

/**
 * Parses JWT from cookies and returns the payload
 */
function parseAuthCookie(request) {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  
  const cookies = cookieHeader.split(";").reduce((acc, cookie) => {
    const [key, value] = cookie.trim().split("=");
    acc[key] = value;
    return acc;
  }, {});
  
  return cookies.auth_token || null;
}

/**
 * Verifies JWT and extracts user info
 */
function verifyAuthToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret || !token) return null;
  
  try {
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
}

/**
 * GET /api/profile/me
 * 
 * Returns the authenticated user's full profile.
 * Requires valid JWT cookie from profile creation.
 */
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "profile/me", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
      try {
        // Authenticate via JWT cookie
        const token = parseAuthCookie(request);
        const payload = verifyAuthToken(token);
        
        if (!payload || !payload.sub) {
          return NextResponse.json(
            { error: "Authentication required" },
            { status: 401 }
          );
        }
        
        const userId = payload.sub;

        const db = await getDb();
        const users = db.collection("users");

        // Find user by ID
        const user = await users.findOne({ _id: new ObjectId(userId) });

        if (!user) {
          return NextResponse.json(
            { error: "Profile not found" },
            { status: 404 }
          );
        }

        // Return full profile (sanitized - no sensitive fields)
        return NextResponse.json({
          profile: {
            _id: user._id.toString(),
            stellarPublicKey: user.stellarPublicKey,
            displayName: user.displayName,
            bio: user.bio,
            avatarUrl: user.avatarUrl,
            onboardingComplete: user.onboardingComplete ?? false,
            email: user.email || null,
            institution: user.institution || null,
            country: user.country || null,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
          },
        });
      } catch (error) {
        auditLog({
          event: "profile_me_failed",
          route: "profile/me",
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
