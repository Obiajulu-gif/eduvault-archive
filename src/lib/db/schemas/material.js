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
      },
    },
  },
};
