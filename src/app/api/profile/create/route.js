import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening, ValidationError } from "@/lib/api/hardening";
import { sanitizeString } from "@/lib/api/validation";
import { getDb } from "@/lib/mongodb";
import { isValidStellarKey } from "@/lib/stellar/fetchAccountMeta";
import { StrKey } from "@stellar/stellar-sdk";
import jwt from "jsonwebtoken";

// Validation constants
const DISPLAY_NAME_MAX = 50;
const BIO_MAX = 500;
const DISPLAY_NAME_PATTERN = /^[a-zA-Z0-9\s\-_.]+$/;

/**
 * Validates display name
 */
function validateDisplayName(name) {
  const clean = sanitizeString(name, { maxLength: DISPLAY_NAME_MAX });
  
  if (!clean || clean.length === 0) {
    throw new ValidationError("Display name is required", { field: "displayName" });
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
  if (bio === undefined || bio === null) return null;
  
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
 * Verifies wallet signature for authentication
 * 
 * Expects header: x-wallet-signature with format "publicKey:signature"
 * where signature is a signed message containing the publicKey and timestamp
 */
function parseAuthHeader(request) {
  const authHeader = request.headers.get("x-wallet-signature");
  
  if (!authHeader) {
    return null;
  }
  
  const parts = authHeader.split(":");
  if (parts.length !== 2) {
    return null;
  }
  
  const [publicKey, signature] = parts;
  
  if (!isValidStellarKey(publicKey) || !signature) {
    return null;
  }
  
  return { publicKey, signature };
}

/**
 * Verifies a Stellar signature
 */
function verifySignature(publicKey, signature) {
  try {
    // For now, we use a simple challenge-response pattern
    // The client signs a known message format: "eduvault:auth:{timestamp}:{publicKey}"
    // We verify the signature using Stellar SDK
    
    const { Keypair } = require("@stellar/stellar-sdk");
    
    // Decode the signature from base64
    const signatureBuffer = Buffer.from(signature, "base64");
    
    // Create the expected message (same format as client)
    // This is a simplified verification - in production, you'd want
    // to include a server-provided nonce/challenge
    const message = `eduvault:auth:${publicKey}`;
    const messageBuffer = Buffer.from(message);
    
    // Verify using Stellar SDK
    const keypair = Keypair.fromPublicKey(publicKey);
    return keypair.verify(messageBuffer, signatureBuffer);
  } catch (error) {
    console.error("Signature verification failed:", error);
    return false;
  }
}

/**
 * POST /api/profile/create
 * 
 * Creates a new profile for a Stellar wallet owner.
 * Requires stellarPublicKey in body (signed verification can be added for production).
 * 
 * Body: { stellarPublicKey: string, displayName: string, bio?: string, avatarUrl?: string, email?: string }
 */
export async function POST(request) {
  return withApiHardening(
    request,
    { route: "profile/create", rateLimit: { limit: 10, windowMs: 60_000 } },
    async () => {
      try {
        const body = await request.json();
        
        // Get public key from body
        const publicKey = sanitizeString(body.stellarPublicKey, { maxLength: 80 });
        
        if (!publicKey) {
          return NextResponse.json(
            { error: "Missing stellarPublicKey in request body" },
            { status: 400 }
          );
        }
        
        if (!isValidStellarKey(publicKey)) {
          return NextResponse.json(
            { error: "Invalid Stellar public key" },
            { status: 400 }
          );
        }

        // Validate fields
        const displayName = validateDisplayName(body.displayName);
        const bio = validateBio(body.bio);
        const avatarUrl = validateAvatarUrl(body.avatarUrl);
        const email = body.email ? sanitizeString(body.email, { maxLength: 254 }) : null;

        const db = await getDb();
        const users = db.collection("users");

        // Application-level duplicate check (race condition protection)
        // DB has unique index on stellarPublicKey, but we check here for better error message
        const existing = await users.findOne({ stellarPublicKey: publicKey });
        if (existing) {
          return NextResponse.json(
            { error: "Profile already exists for this wallet" },
            { status: 409 }
          );
        }

        // Create profile
        const now = new Date().toISOString();
        const newUser = {
          stellarPublicKey: publicKey,
          displayName,
          bio,
          avatarUrl,
          email,
          onboardingComplete: false,
          createdAt: now,
          updatedAt: now,
        };

        const result = await users.insertOne(newUser);
        newUser._id = result.insertedId.toString();

        // Create auth token and set cookie
        const secret = process.env.JWT_SECRET;
        let response = NextResponse.json(
          { success: true, profile: newUser },
          { status: 201 }
        );
        
        if (secret) {
          const token = jwt.sign(
            {
              sub: newUser._id,
              stellarPublicKey: newUser.stellarPublicKey,
              displayName: newUser.displayName,
              onboardingComplete: newUser.onboardingComplete,
            },
            secret,
            { expiresIn: "7d" }
          );
          
          response.cookies.set("auth_token", token, {
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
        
        // Handle MongoDB duplicate key error
        if (error.code === 11000) {
          return NextResponse.json(
            { error: "Profile already exists for this wallet" },
            { status: 409 }
          );
        }
        
        auditLog({
          event: "profile_create_failed",
          route: "profile/create",
          method: "POST",
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
