// Resolves: Create API routes to save and update creator profiles in the database.
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import {
  escapeRegExp,
  getDefaultNotificationPreferences,
  normalizeWalletAddress,
  validateProfilePayload,
  validatePayoutSettingsPayload,
} from "@/lib/api/validation";
import { getUserFromCookie, sanitizeString } from "@/lib/api/auth";
import { verifyChallenge } from "@/lib/auth/challenge";
import { verifySessionWalletAddress } from "@/lib/auth/sessionVerification";
import { sendWelcomeEmail } from "@/lib/email";
import { getDb } from "@/lib/mongodb";
import { getUserIdString, getWalletAddresses, getUserQuery } from "@/lib/profile/accountData";
import {
  buildAnonymizedProfileUpdate,
  buildReviewAnonymizationUpdate,
  buildReviewerQuery,
} from "@/lib/profile/accountPrivacy";

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
      ...profile,
      notificationPreferences: getDefaultNotificationPreferences(),
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

export async function DELETE(request) {
  return withApiHardening(
    request,
    { route: "profile", rateLimit: { limit: 5, windowMs: 60 * 60 * 1000 } },
    async () => {
      try {
        const sessionUser = await getUserFromCookie(request);
        if (!sessionUser) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        let body;
        try {
          body = await request.json();
        } catch {
          return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        const address = normalizeWalletAddress(body?.address);
        const nonce = sanitizeString(body?.nonce, { maxLength: 256 });
        const signedTransactionXdr = sanitizeString(body?.signedTransactionXdr, { maxLength: 10000 });
        if (!address || !nonce || !signedTransactionXdr) {
          return NextResponse.json(
            { error: "A wallet address, nonce and signed transaction are required" },
            { status: 400 }
          );
        }

        const sessionAddresses = getWalletAddresses(sessionUser).map((value) => value.toLowerCase());
        if (!sessionAddresses.includes(address.toLowerCase())) {
          auditLog({ event: "profile_delete_forbidden", route: "profile", method: "DELETE", status: 403 });
          return NextResponse.json({ error: "Forbidden: Wallet address mismatch" }, { status: 403 });
        }

        const proof = await verifyChallenge(address, nonce, signedTransactionXdr, {
          action: "delete_profile",
          origin: sanitizeString(body.origin, { maxLength: 200 }) || undefined,
          network: sanitizeString(body.network, { maxLength: 100 }) || undefined,
          contract: sanitizeString(body.contract, { maxLength: 200 }) || undefined,
        });
        if (!proof.valid) {
          auditLog({ event: "profile_delete_signature_invalid", route: "profile", method: "DELETE", status: 403, reason: proof.reason });
          return NextResponse.json(
            { error: "Invalid or expired wallet signature", reason: proof.reason },
            { status: 403 }
          );
        }

        const db = await getDb();
        const users = db.collection("users");
        const user = await users.findOne(getUserQuery(sessionUser, address));
        if (!user) {
          return NextResponse.json({ error: "User not found" }, { status: 404 });
        }

        const userAddresses = getWalletAddresses(user);
        if (!userAddresses.some((value) => value.toLowerCase() === address.toLowerCase())) {
          return NextResponse.json({ error: "Forbidden: Wallet address mismatch" }, { status: 403 });
        }

        const now = new Date();
        const userUpdate = buildAnonymizedProfileUpdate(getUserIdString(user), now);
        await users.updateOne({ _id: user._id }, userUpdate);

        const reviewerQuery = buildReviewerQuery(
          [...userAddresses, address],
          [user._id, user.sub]
        );
        if (reviewerQuery) {
          const reviewUpdate = buildReviewAnonymizationUpdate(now);
          await db.collection("reviews").updateMany(reviewerQuery, reviewUpdate);
          await db.collection("material_feedback").updateMany(reviewerQuery, reviewUpdate);
        }

        const sessionIdentifiers = [...new Set([
          String(user._id || ""),
          String(user.sub || ""),
          ...userAddresses,
          address,
        ].filter(Boolean))];
        await db.collection("refresh_tokens").deleteMany({ userId: { $in: sessionIdentifiers } });
        await db.collection("auth_challenges").deleteMany({
          address: { $in: sessionIdentifiers.map((value) => value.toLowerCase()) },
        });

        auditLog({
          event: "profile_deleted",
          route: "profile",
          method: "DELETE",
          status: 200,
          actor: getUserIdString(sessionUser),
        });

        const response = NextResponse.json({
          success: true,
          deletedAt: now.toISOString(),
          financialRecordsRetained: true,
        });
        response.cookies.set("auth_token", "", {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: 0,
        });
        response.cookies.set("refresh_token", "", {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          path: "/api/auth/refresh",
          maxAge: 0,
        });
        return response;
      } catch (error) {
        auditLog({ event: "profile_delete_failed", route: "profile", method: "DELETE", status: 500, reason: error.message });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
