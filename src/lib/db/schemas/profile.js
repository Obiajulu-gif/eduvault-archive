/**
 * Core Data Schema Definition for User Profiles
 * Used for documentation, type parsing, and runtime verification.
 *
 * All new user documents MUST include a `uuid` field generated at
 * registration time via crypto.randomUUID(). Legacy users without a uuid
 * should be backfilled using scripts/migrations/assign-uuids.mjs.
 */
export const ProfileSchema = {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["uuid", "walletAddress", "createdAt"],
      properties: {
        uuid: {
          bsonType: "string",
          description: "RFC 4122 UUID uniquely identifying this user across systems",
        },
        walletAddress: {
          bsonType: "string",
          description: "Primary blockchain wallet address used for authentication",
        },
        displayName: {
          bsonType: "string",
          description: "Optional human-readable name shown on public profile pages",
        },
        email: {
          bsonType: "string",
          description: "Optional email address for notifications and recovery",
        },
        avatarCid: {
          bsonType: "string",
          description: "IPFS Content Identifier for the user's profile avatar",
        },
        bio: {
          bsonType: "string",
          description: "Short creator biography displayed on the marketplace",
        },
        createdAt: {
          bsonType: "date",
          description: "Timestamp recording when the profile was first created",
        },
        updatedAt: {
          bsonType: "date",
          description: "Timestamp of the most recent profile update",
        },
        isSuspended: {
          bsonType: "bool",
          description:
            "True while the account is suspended for a guideline or copyright " +
            "violation. Suspended sessions are rejected at the auth boundary " +
            "and the creator's listings are hidden from public discovery.",
        },
        suspendedAt: {
          bsonType: "date",
          description: "When the suspension was applied (absent while active)",
        },
        suspendedBy: {
          bsonType: "string",
          description: "Identifier of the admin who applied the suspension",
        },
        suspensionReason: {
          bsonType: "string",
          description: "Reason shown to the user and recorded in the admin audit log",
        },
      },
    },
  },
};
