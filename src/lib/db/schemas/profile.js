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
      required: ["uuid", "walletAddress", "email", "createdAt"],
      properties: {
        uuid: {
          bsonType: "string",
          description: "RFC 4122 UUID uniquely identifying this user across systems",
        },
        walletAddress: {
          bsonType: "string",
          description: "Primary Stellar wallet address used for authentication",
        },
        walletAddressLower: {
          bsonType: "string",
          description: "Lowercase wallet address for case-insensitive lookups",
        },
        displayName: {
          bsonType: "string",
          description: "Optional human-readable name shown on public profile pages",
        },
        fullName: {
          bsonType: "string",
          description: "Display name of the user",
        },
        email: {
          bsonType: "string",
          description: "Primary contact email address",
        },
        avatarCid: {
          bsonType: "string",
          description: "IPFS Content Identifier for the user's profile avatar",
        },
        bio: {
          bsonType: "string",
          description: "Short creator biography displayed on the marketplace",
        },
        averageRating: {
          bsonType: "double",
          description: "Cached average rating derived from all reviews on creator materials",
        },
        reviewCount: {
          bsonType: "int",
          description: "Cached count of approved reviews on creator materials",
        },
        createdAt: {
          bsonType: "string",
          description: "ISO 8601 timestamp of profile creation",
        },
        updatedAt: {
          bsonType: "string",
          description: "ISO 8601 timestamp of last profile update",
        },
      },
    },
  },
};

export const PROFILE_COLLECTION = "users";
