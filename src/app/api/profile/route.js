export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import { escapeRegExp, normalizeWalletAddress, validateProfilePayload } from "@/lib/api/validation";
import { sendWelcomeEmail } from "@/lib/email";
import { getDb } from "@/lib/mongodb";
import jwt from "jsonwebtoken";

export async function POST(request) {
  return withApiHardening(
    request,
    { route: "profile", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
  try {
    const profile = validateProfilePayload(await request.json());
    const { fullName, email, walletAddress, walletAddressLower } = profile;

    const db = await getDb();
    const users = db.collection("users");

    // Check duplicate by email or wallet address (if provided)
    const duplicateQuery = walletAddress
      ? { $or: [
          { email },
          { walletAddress },
          { walletAddress: walletAddressLower },
          { walletAddressLower }
        ] }
      : { email };
    const existing = await users.findOne(duplicateQuery);
    if (existing) {
      return NextResponse.json({ error: "Profile already exists" }, { status: 409 });
    }

    const newUser = {
      ...profile,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await users.insertOne(newUser);
    newUser._id = result.insertedId;

    // Attempt to send welcome email (non-blocking failure)
    let emailSent = false;
    try {
      await sendWelcomeEmail(email, fullName);
      emailSent = true;
    } catch (e) {
      // Log server-side; don’t fail profile creation on email issues
      console.error("Welcome email failed:", e?.message || e);
    }

    // Create auth token and set httpOnly cookie
    const secret = process.env.JWT_SECRET;
    let response = NextResponse.json({ success: true, user: newUser, emailSent });
    if (secret) {
      const token = jwt.sign(
        {
          sub: newUser._id.toString(),
          email: newUser.email,
          name: newUser.fullName,
          walletAddress: newUser.walletAddress,
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
    } else {
      console.warn("JWT_SECRET is not set; auth cookie will not be created.");
    }

    return response;
  } catch (error) {
    if (error.name === "ValidationError") throw error;
    auditLog({ event: "profile_create_failed", route: "profile", method: "POST", status: 500, reason: error.message });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
    }
  );
}

// GET /api/profile?address=0x...
// Returns { exists: boolean, user?: object }
export async function GET(request) {
  return withApiHardening(
    request,
    { route: "profile", rateLimit: { limit: 60, windowMs: 60_000 } },
    async () => {
  try {
    const { searchParams } = new URL(request.url);
    const address = normalizeWalletAddress(searchParams.get("address"));

    if (!address) {
      return NextResponse.json({ error: "Missing address" }, { status: 400 });
    }

    const db = await getDb();
    const users = db.collection("users");
    const addressLower = address.toLowerCase();
    const user = await users.findOne({
      $or: [
        { walletAddress: address },
        { walletAddressLower: addressLower },
        { walletAddress: { $regex: `^${escapeRegExp(address)}$`, $options: "i" } },
      ],
    });

    // If a user exists, also issue an auth cookie so dashboard access works
    const exists = !!user;
    const response = NextResponse.json({ exists, user: user || null });
    if (exists) {
      const secret = process.env.JWT_SECRET;
      if (secret) {
        const token = jwt.sign(
          {
            sub: user._id.toString(),
            email: user.email,
            name: user.fullName,
            walletAddress: user.walletAddress,
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
      } else {
        console.warn("JWT_SECRET is not set; cannot create auth cookie on GET /api/profile.");
      }
    }

    return response;
  } catch (error) {
    if (error.name === "ValidationError") throw error;
    auditLog({ event: "profile_lookup_failed", route: "profile", method: "GET", status: 500, reason: error.message });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
    }
  );
}
