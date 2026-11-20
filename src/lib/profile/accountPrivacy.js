import { normalizeNotificationPreferences } from "@/lib/api/validation";
import { buildWalletQuery, getWalletAddresses } from "@/lib/profile/accountData";

const EXPORT_SENSITIVE_FIELDS = [
  "passwordHash",
  "password",
  "refreshToken",
  "accessToken",
  "verificationToken",
  "challenge",
  "nonce",
];

const PROFILE_PII_FIELDS = [
  "name",
  "bio",
  "avatarUrl",
  "avatarCid",
  "institution",
  "country",
  "twitterUrl",
  "githubUrl",
  "websiteUrl",
  "payoutWalletAddress",
  "payoutWalletAddressLower",
  "payoutNotes",
  "phone",
  "dateOfBirth",
  "walletAddressLower",
  "address",
  "publicKey",
  "lastInactivityReminderAt",
];

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))];
}

function toJson(value) {
  if (value === undefined || value === null) return value ?? null;
  return JSON.parse(JSON.stringify(value));
}

export function sanitizeExportedProfile(user) {
  if (!user) return null;
  const profile = { ...user };
  for (const field of EXPORT_SENSITIVE_FIELDS) {
    delete profile[field];
  }
  profile.notificationPreferences = normalizeNotificationPreferences(
    profile.notificationPreferences
  );
  return toJson(profile);
}

export function buildExportQueries(user) {
  const addresses = getWalletAddresses(user);
  const ids = unique([user?.sub, user?._id]);
  const walletQuery = buildWalletQuery("walletAddress", addresses);
  const reviewerQuery = buildReviewerQuery(addresses, ids);

  return {
    purchases: buildWalletQuery("buyerAddress", addresses),
    notes: walletQuery,
    savedItems: walletQuery,
    reviews: reviewerQuery,
    feedback: reviewerQuery,
  };
}

export function buildReviewerQuery(addresses, ids = []) {
  const addressClauses = buildWalletQuery("reviewerAddress", addresses)?.$or || [];
  const idValues = unique(ids);
  const clauses = [
    ...addressClauses,
    ...(idValues.length > 0 ? [{ reviewerId: { $in: idValues } }] : []),
  ];
  if (clauses.length === 0) return null;
  return { $or: clauses };
}

export function buildProfileExport(user, collections = {}, exportedAt = new Date()) {
  return {
    format: "eduvault.profile-export.v1",
    exportedAt: exportedAt.toISOString(),
    profile: sanitizeExportedProfile(user),
    purchases: toJson(collections.purchases || []),
    notes: toJson(collections.notes || []),
    savedItems: toJson(collections.savedItems || []),
    reviews: toJson(collections.reviews || []),
    feedback: toJson(collections.feedback || []),
  };
}

export function buildAnonymizedProfileUpdate(userId, now = new Date()) {
  const suffix = String(userId || "unknown").replace(/[^a-zA-Z0-9]/g, "") || "unknown";
  const timestamp = now.toISOString();

  return {
    $set: {
      fullName: "Deleted user",
      displayName: "Deleted user",
      walletAddress: `deleted:${suffix}`,
      email: `deleted-${suffix}@deleted.eduvault.invalid`,
      notificationPreferences: {
        receipts: true,
        reviews: false,
        sales: false,
        reminders: false,
        productUpdates: false,
      },
      status: "deleted",
      deletedAt: timestamp,
      anonymizedAt: timestamp,
      updatedAt: timestamp,
    },
    $unset: Object.fromEntries(PROFILE_PII_FIELDS.map((field) => [field, ""])),
  };
}

export function buildReviewAnonymizationUpdate(now = new Date()) {
  const timestamp = now.toISOString();
  return {
    $set: {
      reviewerAddress: null,
      reviewerName: null,
      reviewerId: null,
      anonymized: true,
      anonymizedAt: timestamp,
      updatedAt: timestamp,
    },
  };
}
