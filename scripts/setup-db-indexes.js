import { getDb } from "../src/lib/mongodb.js";

async function setupMarketplaceIndexes() {
  console.log("=== Setting up Marketplace Indexes for Cursor-Based Pagination ===");
  const db = await getDb();
  const collection = db.collection("materials");

  try {
    // Create indexes for different sort patterns used in marketplace
    
    // 1. Default sort (newest first) - compound index with _id for cursor pagination
    console.log("Creating index for newest sort (createdAt: -1, _id: -1)...");
    await collection.createIndex(
      { createdAt: -1, _id: -1 },
      { 
        name: "marketplace_newest_cursor",
        background: true 
      }
    );

    // 2. Price ascending sort - compound index
    console.log("Creating index for price ascending sort (price: 1, _id: 1)...");
    await collection.createIndex(
      { price: 1, _id: 1 },
      { 
        name: "marketplace_price_asc_cursor",
        background: true 
      }
    );

    // 3. Price descending sort - compound index
    console.log("Creating index for price descending sort (price: -1, _id: -1)...");
    await collection.createIndex(
      { price: -1, _id: -1 },
      { 
        name: "marketplace_price_desc_cursor",
        background: true 
      }
    );

    // 4. Rating descending sort - compound index
    console.log("Creating index for rating sort (rating: -1, _id: -1)...");
    await collection.createIndex(
      { rating: -1, _id: -1 },
      { 
        name: "marketplace_rating_cursor",
        background: true 
      }
    );

    // 5. Popular sort (likes + rating) - compound index
    console.log("Creating index for popular sort (likes: -1, rating: -1, _id: -1)...");
    await collection.createIndex(
      { likes: -1, rating: -1, _id: -1 },
      { 
        name: "marketplace_popular_cursor",
        background: true 
      }
    );

    // 6. General marketplace query index for filtering
    console.log("Creating index for marketplace filters...");
    await collection.createIndex(
      {
        visibility: 1,
        archived: 1,
        moderationStatus: 1,
        isDeleted: 1,
        creatorSuspended: 1,
        createdAt: -1
      },
      { 
        name: "marketplace_filters",
        background: true,
        partialFilterExpression: {
          visibility: "public",
          archived: { $ne: true },
          moderationStatus: { $ne: "suspended" },
          isDeleted: { $ne: true },
          creatorSuspended: { $ne: true }
        }
      }
    );

    console.log("✅ All marketplace indexes created successfully!");

    // List existing indexes for verification
    console.log("\n=== Current Indexes ===");
    const indexes = await collection.indexes();
    indexes.forEach((index, i) => {
      console.log(`${i + 1}. ${index.name}: ${JSON.stringify(index.key)}`);
    });

  } catch (error) {
    console.error("❌ Error creating indexes:", error);
    throw error;
  }
}

async function runPaginationPerformanceTest() {
  console.log("\n=== Running Cursor vs Offset Pagination Performance Test ===");
  const db = await getDb();
  const collection = db.collection("materials");

  // Ensure we have test data
  const count = await collection.countDocuments();
  console.log(`Collection has ${count} documents`);

  if (count < 1000) {
    console.log("Generating test data for pagination performance test...");
    const testData = Array.from({ length: 2000 }, (_, idx) => ({
      title: `Test Material ${idx}`,
      description: `Description for test material ${idx}`,
      price: Math.floor(Math.random() * 100),
      rating: Math.random() * 5,
      likes: Math.floor(Math.random() * 1000),
      visibility: "public",
      archived: false,
      moderationStatus: "approved",
      isDeleted: false,
      creatorSuspended: false,
      createdAt: new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000),
    }));
    await collection.insertMany(testData);
    console.log("✅ Test data created");
  }

  const query = {
    visibility: "public",
    archived: { $ne: true },
    moderationStatus: { $ne: "suspended" },
    isDeleted: { $ne: true },
    creatorSuspended: { $ne: true },
  };

  // Test offset-based pagination (page 50, simulating deep pagination)
  console.log("\n--- Testing Offset-Based Pagination (Page 50) ---");
  const offsetStartTime = performance.now();
  
  const offsetExplain = await collection
    .find(query)
    .sort({ createdAt: -1 })
    .skip(49 * 12) // Page 50 with 12 items per page
    .limit(12)
    .explain("executionStats");
  
  const offsetEndTime = performance.now();
  const offsetTime = offsetEndTime - offsetStartTime;
  
  console.log(`Offset Pagination Performance:`);
  console.log(`- Execution time: ${offsetTime.toFixed(2)}ms`);
  console.log(`- Documents examined: ${offsetExplain.executionStats.totalDocsExamined}`);
  console.log(`- Index used: ${!JSON.stringify(offsetExplain).includes("COLLSCAN")}`);

  // Test cursor-based pagination (equivalent position)
  console.log("\n--- Testing Cursor-Based Pagination (Equivalent Position) ---");
  
  // First get a cursor from around the same position
  const referenceDoc = await collection
    .findOne(query, { sort: { createdAt: -1 }, skip: 49 * 12 });
  
  if (referenceDoc) {
    const cursorStartTime = performance.now();
    
    const cursorQuery = {
      ...query,
      createdAt: { $lt: referenceDoc.createdAt }
    };
    
    const cursorExplain = await collection
      .find(cursorQuery)
      .sort({ createdAt: -1 })
      .limit(12)
      .explain("executionStats");
    
    const cursorEndTime = performance.now();
    const cursorTime = cursorEndTime - cursorStartTime;
    
    console.log(`Cursor Pagination Performance:`);
    console.log(`- Execution time: ${cursorTime.toFixed(2)}ms`);
    console.log(`- Documents examined: ${cursorExplain.executionStats.totalDocsExamined}`);
    console.log(`- Index used: ${!JSON.stringify(cursorExplain).includes("COLLSCAN")}`);
    
    const improvement = ((offsetTime - cursorTime) / offsetTime * 100).toFixed(1);
    console.log(`\n🚀 Performance improvement: ${improvement}% faster with cursor pagination`);
  }

  console.log("\n✅ Performance test completed!");
}

async function main() {
  try {
    await setupMarketplaceIndexes();
    await runPaginationPerformanceTest();
    console.log("\n🎉 Database setup completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("💥 Database setup failed:", error);
    process.exit(1);
  }
}

main();
