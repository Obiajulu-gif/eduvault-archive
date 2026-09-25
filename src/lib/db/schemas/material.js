/**
 * Core Data Schema Definition for Marketplace Materials
 * Used for documentation, type parsing, and runtime verification.
 */
export const MaterialSchema = {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["title", "description", "category", "price", "createdAt"],
      properties: {
        title: {
          bsonType: "string",
          description: "Must be a string representing the material title",
        },
        description: {
          bsonType: "string",
          description: "Detailed information regarding educational content",
        },
        category: {
          bsonType: "string",
          description: "Broad grouping categorizing the listing framework",
        },
        price: {
          bsonType: "double",
          description: "Decimal asset valuation matching listing limits",
        },
        cid: {
          bsonType: "string",
          description: "IPFS Content Identifier pointing to the raw file asset",
        },
        storageKey: {
          bsonType: "string",
          description: "Primary storage key/content hash for the uploaded asset",
        },
        quarantineState: {
          bsonType: "string",
          description: "Quarantine scan state for the associated content hash",
        },
        quarantineExpiresAt: {
          bsonType: "date",
          description: "When the quarantine record expires",
        },
        createdAt: {
          bsonType: "date",
          description: "Timestamp tracing entity entry operations",
        },
        isDeleted: {
          bsonType: "bool",
          description:
            "Soft-delete flag. Hard-deleting a material orphans the download " +
            "references of everyone who already purchased it, so listings are " +
            "retired by setting this to true instead. Public catalog queries " +
            "filter these out; entitlement-backed downloads deliberately do not.",
        },
        deletedAt: {
          bsonType: "date",
          description: "When the listing was soft-deleted (absent while active)",
        },
        deletedBy: {
          bsonType: "string",
          description: "Identifier of the creator or admin who retired the listing",
        },
        deletionReason: {
          bsonType: "string",
          description: "Free-text reason recorded at soft-delete time",
        },
        previewImages: {
          bsonType: "array",
          items: {
            bsonType: "string",
            description: "IPFS CID for preview image",
          },
          maxItems: 5,
          description: "Array of CIDs for preview images (gallery)",
        },
      },
    },
  },
};
