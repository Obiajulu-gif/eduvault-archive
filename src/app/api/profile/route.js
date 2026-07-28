// Resolves: Create API routes to save and update creator profiles in the database.
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import {
  escapeRegExp,
  normalizeWalletAddress,
  validateProfilePayload,
  validatePayoutSettingsPayload,
} from "@/lib/api/validation";
import { getUserFromCookie, sanitizeString } from "@/lib/api/auth";
import { verifySessionWalletAddress } from "@/lib/auth/sessionVerification";
import { sendWelcomeEmail } from "@/lib/email";
import { getDb } from "@/lib/mongodb";

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
      uuid: crypto.randomUUID(),
      ...profile,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await users.insertOne(newUser);
    newUser._id = result.insertedId;

    let emailSent = false;
    try {
      await sendWelcomeEmail(email, fullName);
      emailSent = true;
    } catch (e) {
      console.error("Welcome email failed:", e?.message || e);
    }

    return NextResponse.json({ success: true, user: newUser, emailSent });
  } catch (error) {
    if (error.name === "ValidationError") throw error;
    auditLog({ event: "profile_create_failed", route: "profile", method: "POST", status: 500, reason: error.message });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
    }
  );
}

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

    const exists = !!user;
    return NextResponse.json({ exists, user: user || null });
  } catch (error) {
    if (error.name === "ValidationError") throw error;
    auditLog({ event: "profile_lookup_failed", route: "profile", method: "GET", status: 500, reason: error.message });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
    }
  );
}

export async function PATCH(request) {
  return withApiHardening(
    request,
    { route: "profile", rateLimit: { limit: 30, windowMs: 60_000 } },
    async () => {
      try {
        const user = await getUserFromCookie(request);
        if (!user) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const profileData = await request.json();

        if (profileData.walletAddress) {
          if (!verifySessionWalletAddress(user, profileData)) {
            auditLog({ event: "profile_update_forbidden", route: "profile", method: "PATCH", status: 403 });
            return NextResponse.json({ error: "Forbidden: Wallet address mismatch" }, { status: 403 });
          }
        }

        const updateFields = {};

        if (profileData.displayName && typeof profileData.displayName === 'string') {
          updateFields.fullName = sanitizeString(profileData.displayName, { maxLength: 120 });
        }

        if (profileData.bio && typeof profileData.bio === 'string') {
          updateFields.bio = sanitizeString(profileData.bio, { maxLength: 1000 });
        }

        if (profileData.avatarUrl && typeof profileData.avatarUrl === 'string') {
          updateFields.avatarUrl = sanitizeString(profileData.avatarUrl, { maxLength: 2048 });
        }

        if (profileData.institution && typeof profileData.institution === 'string') {
          updateFields.institution = sanitizeString(profileData.institution, { maxLength: 160 });
        }

        if (profileData.country && typeof profileData.country === 'string') {
          updateFields.country = sanitizeString(profileData.country, { maxLength: 80 });
        }

        if (profileData.twitterUrl && typeof profileData.twitterUrl === 'string') {
          updateFields.twitterUrl = sanitizeString(profileData.twitterUrl, { maxLength: 256 });
        }

        if (profileData.githubUrl && typeof profileData.githubUrl === 'string') {
          updateFields.githubUrl = sanitizeString(profileData.githubUrl, { maxLength: 256 });
        }

        if (profileData.websiteUrl && typeof profileData.websiteUrl === 'string') {
          updateFields.websiteUrl = sanitizeString(profileData.websiteUrl, { maxLength: 256 });
        }

        if (profileData.coverPhoto && typeof profileData.coverPhoto === 'string') {
          updateFields.coverPhoto = sanitizeString(profileData.coverPhoto, { maxLength: 500000 });
        }

        if (profileData.coverUrl && typeof profileData.coverUrl === 'string') {
          updateFields.coverUrl = sanitizeString(profileData.coverUrl, { maxLength: 500000 });
        }

        if (
          profileData.payoutWalletAddress !== undefined ||
          profileData.preferredPayoutCurrency !== undefined ||
          profileData.payoutNotes !== undefined
        ) {
          const payoutSettings = validatePayoutSettingsPayload(profileData);
          if (payoutSettings.payoutWalletAddress !== undefined) {
            updateFields.payoutWalletAddress = payoutSettings.payoutWalletAddress;
            updateFields.payoutWalletAddressLower = payoutSettings.payoutWalletAddressLower;
          }
          if (payoutSettings.preferredPayoutCurrency !== undefined) {
            updateFields.preferredPayoutCurrency = payoutSettings.preferredPayoutCurrency;
          }
          if (payoutSettings.payoutNotes !== undefined) {
            updateFields.payoutNotes = payoutSettings.payoutNotes;
          }
        }

        if (Object.keys(updateFields).length === 0) {
          return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
        }

        const db = await getDb();
        const users = db.collection("users");
        const userId = ObjectId.isValid(user.sub) ? new ObjectId(user.sub) : null;
        const updateQuery = userId
          ? { _id: userId }
          : user.walletAddress
            ? {
                $or: [
                  { walletAddress: user.walletAddress },
                  { walletAddressLower: String(user.walletAddress).toLowerCase() },
                ],
              }
            : { _id: user._id };

        const result = await users.updateOne(
          updateQuery,
          {
            $set: {
              ...updateFields,
              updatedAt: new Date().toISOString()
            }
          }
        );

        if (result.matchedCount === 0) {
          return NextResponse.json({ error: "User not found" }, { status: 404 });
        }

        const updatedUser = await users.findOne(updateQuery);

        return NextResponse.json({ success: true, user: updatedUser });
      } catch (error) {
        if (error.name === "ValidationError") throw error;
        auditLog({ event: "profile_update_failed", route: "profile", method: "PATCH", status: 500, reason: error.message });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
