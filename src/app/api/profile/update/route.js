import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening, ValidationError } from "@/lib/api/hardening";
import { sanitizeString } from "@/lib/api/validation";
import { getDb } from "@/lib/mongodb";
import { isValidStellarKey } from "@/lib/stellar/fetchAccountMeta";
import { StrKey } from "@stellar/stellar-sdk";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";

// Validation constants
const DISPLAY_NAME_MAX = 50;
const BIO_MAX = 500;
const DISPLAY_NAME_PATTERN = /^[a-zA-Z0-9\s\-_.]+$/;

/**
 * Validates display name
 */
function validateDisplayName(name) {
  if (name === undefined) return undefined;
  
  const clean = sanitizeString(name, { maxLength: DISPLAY_NAME_MAX });
  
  if (!clean || clean.length === 0) {
    throw new ValidationError("Display name cannot be empty", { field: "displayName" });
  }
  
  if (clean.length > DISPLAY_NAME_MAX) {
    throw new ValidationError(
      `Display name must be ${DISPLAY_NAME_MAX} characters or less`,
      { field: "displayName" }
    );
  }
  
  if (!DISPLAY_NAME_PATTERN.test(clean)) {
    throw new ValidationError(
      "Display name can only contain letters, numbers, spaces, hyphens, underscores, and periods",
      { field: "displayName" }
    );
  }
  
  return clean;
}

/**
 * Validates bio
 */
function validateBio(bio) {
  if (bio === undefined || bio === null) return undefined;
  
  const clean = sanitizeString(bio, { maxLength: BIO_MAX });
  
  if (clean.length > BIO_MAX) {
    throw new ValidationError(
      `Bio must be ${BIO_MAX} characters or less`,
      { field: "bio" }
    );
  }
  
  return clean || null;
}

/**
 * Validates avatar URL
 */
function validateAvatarUrl(url) {
  if (url === undefined || url === null) return undefined;
  if (!url) return null;
  
  const clean = sanitizeString(url, { maxLength: 2048 });
  
  // Must be https:// in production, allow http:// in development
  const isDev = process.env.NODE_ENV !== "production";
  const urlPattern = isDev 
    ? /^https?:\/\/.+/i 
    : /^https:\/\/.+/i;
  
  if (!urlPattern.test(clean)) {
    throw new ValidationError(
      "Avatar URL must be a valid HTTPS URL",
      { field: "avatarUrl" }
    );
  }
  
  return clean;
}

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
 * PATCH /api/profile/update
 * 
 * Updates an existing profile. Requires authentication.
 * Only the profile owner can update their profile.
 * 
 * Body: { displayName?: string, bio?: string, avatarUrl?: string, onboardingComplete?: boolean }
 */
export async function PATCH(request) {
  return withApiHardening(
    request,
    { route: "profile/update", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      try {
        // Authenticate via JWT cookie
        const token = parseAuthCookie(request);
        const payload = verifyAuthToken(token);
        
        if (!payload) {
          return NextResponse.json(
            { error: "Authentication required" },
            { status: 401 }
          );
        }
        
        const userId = payload.sub;
        const stellarPublicKey = payload.stellarPublicKey;
        
        if (!userId) {
          return NextResponse.json(
            { error: "Invalid authentication token" },
            { status: 401 }
          );
        }

        const body = await request.json();

        // Validate fields (only validate what's provided)
        const updates = {};
        
        if (body.displayName !== undefined) {
          updates.displayName = validateDisplayName(body.displayName);
        }
        
        if (body.bio !== undefined) {
          updates.bio = validateBio(body.bio);
        }
        
        if (body.avatarUrl !== undefined) {
          updates.avatarUrl = validateAvatarUrl(body.avatarUrl);
        }
        
        if (body.onboardingComplete !== undefined) {
          updates.onboardingComplete = Boolean(body.onboardingComplete);
          
          // If marking onboarding complete, validate displayName exists
          if (updates.onboardingComplete) {
            // We need to check if displayName is being set now or already exists
            if (!updates.displayName) {
              // Fetch current profile to check if displayName exists
              const db = await getDb();
              const users = db.collection("users");
              const currentUser = await users.findOne({ _id: new ObjectId(userId) });
              
              if (!currentUser?.displayName) {
                return NextResponse.json(
                  { error: "Display name is required before completing onboarding" },
                  { status: 422 }
                );
              }
            }
          }
        }

        // Apply update
        const db = await getDb();
        const users = db.collection("users");
        
        const updateDoc = {
          $set: {
            ...updates,
            updatedAt: new Date().toISOString(),
          },
        };

        const result = await users.findOneAndUpdate(
          { _id: new ObjectId(userId) },
          updateDoc,
          { returnDocument: "after" }
        );

        if (!result) {
          return NextResponse.json(
            { error: "Profile not found" },
            { status: 404 }
          );
        }

        // Update JWT cookie with new onboarding status if changed
        const secret = process.env.JWT_SECRET;
        let response = NextResponse.json({
          success: true,
          profile: {
            _id: result._id.toString(),
            stellarPublicKey: result.stellarPublicKey,
            displayName: result.displayName,
            bio: result.bio,
            avatarUrl: result.avatarUrl,
            onboardingComplete: result.onboardingComplete,
            createdAt: result.createdAt,
            updatedAt: result.updatedAt,
          },
        });
        
        if (secret && body.onboardingComplete !== undefined) {
          const newToken = jwt.sign(
            {
              sub: result._id.toString(),
              stellarPublicKey: result.stellarPublicKey,
              displayName: result.displayName,
              onboardingComplete: result.onboardingComplete,
            },
            secret,
            { expiresIn: "7d" }
          );
          
          response.cookies.set("auth_token", newToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            path: "/",
            maxAge: 60 * 60 * 24 * 7,
          });
        }

        return response;
      } catch (error) {
        if (error.name === "ValidationError") {
          throw error;
        }
        
        auditLog({
          event: "profile_update_failed",
          route: "profile/update",
          method: "PATCH",
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
