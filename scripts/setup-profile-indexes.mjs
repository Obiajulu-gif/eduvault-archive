#!/usr/bin/env node
/**
 * MongoDB Index Setup Script for User Profiles
 * 
 * Creates required indexes for the new profile system:
 * - Unique index on stellarPublicKey (for uniqueness enforcement)
 * 
 * Run with: node scripts/setup-profile-indexes.mjs
 */

import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "eduvault";

if (!uri) {
  console.error("Error: MONGODB_URI environment variable is not set");
  console.error("Please set it before running this script:");
  console.error("  export MONGODB_URI='mongodb+srv://...'");
  process.exit(1);
}

async function setupIndexes() {
  const client = new MongoClient(uri);
  
  try {
    await client.connect();
    console.log("Connected to MongoDB");
    
    const db = client.db(dbName);
    const users = db.collection("users");
    
    // Check if index already exists
    const indexes = await users.indexes();
    const hasStellarPublicKeyIndex = indexes.some(
      idx => idx.key && idx.key.stellarPublicKey === 1
    );
    
    if (hasStellarPublicKeyIndex) {
      console.log("✓ Index on stellarPublicKey already exists");
      
      // Check if it's unique
      const existingIndex = indexes.find(idx => idx.key && idx.key.stellarPublicKey === 1);
      if (!existingIndex.unique) {
        console.log("⚠ Warning: Index exists but is not unique");
        console.log("  Dropping and recreating as unique index...");
        await users.dropIndex("stellarPublicKey_1");
        await users.createIndex(
          { stellarPublicKey: 1 },
          { 
            unique: true,
            name: "stellarPublicKey_unique",
            sparse: true // Allow documents without stellarPublicKey during migration
          }
        );
        console.log("✓ Recreated as unique index");
      }
    } else {
      console.log("Creating unique index on stellarPublicKey...");
      
      await users.createIndex(
        { stellarPublicKey: 1 },
        { 
          unique: true,
          name: "stellarPublicKey_unique",
          sparse: true // Allow documents without stellarPublicKey during migration
        }
      );
      
      console.log("✓ Created unique index on stellarPublicKey");
    }
    
    // Also create index for walletAddress lookups (legacy support)
    const hasWalletAddressIndex = indexes.some(
      idx => idx.key && idx.key.walletAddress === 1
    );
    
    if (!hasWalletAddressIndex) {
      console.log("Creating index on walletAddress (legacy support)...");
      await users.createIndex(
        { walletAddress: 1 },
        { sparse: true }
      );
      console.log("✓ Created index on walletAddress");
    }
    
    // Create index for onboardingComplete for efficient queries
    const hasOnboardingIndex = indexes.some(
      idx => idx.key && idx.key.onboardingComplete === 1
    );
    
    if (!hasOnboardingIndex) {
      console.log("Creating index on onboardingComplete...");
      await users.createIndex(
        { onboardingComplete: 1 },
        { sparse: true }
      );
      console.log("✓ Created index on onboardingComplete");
    }
    
    console.log("\n✅ All indexes are set up correctly");
    console.log("\nCurrent indexes on 'users' collection:");
    const finalIndexes = await users.indexes();
    finalIndexes.forEach(idx => {
      const keys = Object.entries(idx.key).map(([k, v]) => `${k}:${v}`).join(", ");
      const unique = idx.unique ? " (unique)" : "";
      console.log(`  - ${idx.name}: { ${keys} }${unique}`);
    });
    
  } catch (error) {
    console.error("\n❌ Error setting up indexes:", error.message);
    process.exit(1);
  } finally {
    await client.close();
    console.log("\nDisconnected from MongoDB");
  }
}

setupIndexes();
