/**
 * Test suite for cursor-based pagination performance
 * Compares cursor vs offset pagination performance with large datasets
 */

import { getDb } from '../src/lib/mongodb.js';
import { buildMarketplaceDiscoveryQuery, buildMarketplaceSort } from '../src/lib/backend/marketplaceDiscovery.js';
import { ObjectId } from 'mongodb';

describe('Pagination Performance Tests', () => {
  let db;
  let collection;
  const TEST_COLLECTION = 'materials_test';

  beforeAll(async () => {
    db = await getDb();
    collection = db.collection(TEST_COLLECTION);
    
    // Create test data
    await setupTestData();
    await createTestIndexes();
  });

  afterAll(async () => {
    // Clean up test collection
    await collection.drop();
  });

  async function setupTestData() {
    // Clear existing test data
    await collection.deleteMany({});

    // Generate 10,000 test documents
    const testData = [];
    const batchSize = 1000;

    for (let batch = 0; batch < 10; batch++) {
      const batchData = Array.from({ length: batchSize }, (_, idx) => {
        const docIndex = batch * batchSize + idx;
        return {
          title: `Test Material ${docIndex}`,
          description: `Description for test material ${docIndex}`,
          price: Math.floor(Math.random() * 100) + 1,
          rating: Math.random() * 5,
          likes: Math.floor(Math.random() * 1000),
          visibility: 'public',
          archived: false,
          moderationStatus: 'approved',
          isDeleted: false,
          creatorSuspended: false,
          createdAt: new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000),
          author: `Test Author ${Math.floor(Math.random() * 100)}`,
          subject: ['math', 'science', 'technology', 'business'][Math.floor(Math.random() * 4)],
          category: ['education', 'research', 'tutorial'][Math.floor(Math.random() * 3)]
        };
      });
      
      await collection.insertMany(batchData);
      testData.push(...batchData);
    }

    console.log(`✅ Created ${testData.length} test documents`);
    return testData;
  }

  async function createTestIndexes() {
    // Create the same indexes as the main application
    const indexes = [
      { createdAt: -1, _id: -1 },
      { price: 1, _id: 1 },
      { price: -1, _id: -1 },
      { rating: -1, _id: -1 },
      { likes: -1, rating: -1, _id: -1 },
      {
        visibility: 1,
        archived: 1,
        moderationStatus: 1,
        isDeleted: 1,
        creatorSuspended: 1,
        createdAt: -1
      }
    ];

    for (const index of indexes) {
      await collection.createIndex(index, { background: true });
    }

    console.log('✅ Created test indexes');
  }

  test('Offset pagination performance degrades with deep pages', async () => {
    const query = buildMarketplaceDiscoveryQuery(new URLSearchParams());
    const sort = buildMarketplaceSort('newest');
    const pageSize = 12;

    // Test pages at different depths
    const testPages = [1, 10, 50, 100, 200];
    const results = [];

    for (const page of testPages) {
      const startTime = performance.now();
      
      const explainResult = await collection
        .find(query)
        .sort(sort)
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .explain('executionStats');
      
      const endTime = performance.now();
      const executionTime = endTime - startTime;
      
      results.push({
        page,
        executionTime,
        docsExamined: explainResult.executionStats.totalDocsExamined,
        indexHit: !JSON.stringify(explainResult).includes('COLLSCAN')
      });
    }

    // Performance should degrade significantly with deeper pages
    const firstPageTime = results[0].executionTime;
    const deepPageTime = results[results.length - 1].executionTime;
    
    console.log('Offset Pagination Performance:', results);
    
    // Deep pages should be significantly slower (at least 2x)
    expect(deepPageTime).toBeGreaterThan(firstPageTime * 1.5);
    
    // Should examine more documents for deeper pages
    expect(results[results.length - 1].docsExamined).toBeGreaterThan(results[0].docsExamined);
  });

  test('Cursor pagination maintains consistent performance', async () => {
    const baseQuery = buildMarketplaceDiscoveryQuery(new URLSearchParams());
    const sort = buildMarketplaceSort('newest');
    const pageSize = 12;

    const results = [];
    let currentCursor = null;

    // Test equivalent "pages" using cursor pagination
    for (let iteration = 0; iteration < 5; iteration++) {
      let query = { ...baseQuery };
      
      // Add cursor conditions if we have one
      if (currentCursor) {
        try {
          const cursorData = JSON.parse(Buffer.from(currentCursor, 'base64').toString('utf8'));
          query.$and = query.$and || [];
          query.$and.push({
            $or: [
              { createdAt: { $lt: new Date(cursorData.createdAt) } },
              { 
                createdAt: new Date(cursorData.createdAt),
                _id: { $lt: new ObjectId(cursorData._id) }
              }
            ]
          });
        } catch (e) {
          // Invalid cursor, start from beginning
        }
      }

      const startTime = performance.now();
      
      const explainResult = await collection
        .find(query)
        .sort(sort)
        .limit(pageSize + 1)
        .explain('executionStats');
      
      const endTime = performance.now();
      const executionTime = endTime - startTime;

      // Get actual results to generate next cursor
      const docs = await collection
        .find(query)
        .sort(sort)
        .limit(pageSize + 1)
        .toArray();

      const hasNextPage = docs.length > pageSize;
      if (hasNextPage) {
        docs.pop(); // Remove extra item
      }

      // Generate next cursor
      if (hasNextPage && docs.length > 0) {
        const lastDoc = docs[docs.length - 1];
        const cursorData = {
          _id: lastDoc._id.toString(),
          createdAt: lastDoc.createdAt.toISOString()
        };
        currentCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
      }

      results.push({
        iteration: iteration + 1,
        executionTime,
        docsExamined: explainResult.executionStats.totalDocsExamined,
        indexHit: !JSON.stringify(explainResult).includes('COLLSCAN'),
        hasNextPage
      });
    }

    console.log('Cursor Pagination Performance:', results);

    // Cursor pagination should maintain consistent performance
    const executionTimes = results.map(r => r.executionTime);
    const avgTime = executionTimes.reduce((a, b) => a + b, 0) / executionTimes.length;
    const maxDeviation = Math.max(...executionTimes.map(t => Math.abs(t - avgTime)));
    
    // Performance should not vary significantly (within 50% of average)
    expect(maxDeviation).toBeLessThan(avgTime * 0.5);
    
    // Should consistently use indexes
    results.forEach(result => {
      expect(result.indexHit).toBe(true);
    });
  });

  test('Cursor encoding and decoding works correctly', () => {
    const testData = {
      _id: new ObjectId().toString(),
      createdAt: new Date().toISOString(),
      price: 25.99,
      rating: 4.5
    };

    // Encode cursor
    const cursor = Buffer.from(JSON.stringify(testData)).toString('base64');
    
    // Decode cursor
    const decodedData = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));

    expect(decodedData).toEqual(testData);
  });

  test('Different sort orders produce valid cursors', async () => {
    const sortTypes = ['newest', 'price_asc', 'price_desc', 'rating_desc'];
    
    for (const sortType of sortTypes) {
      const query = buildMarketplaceDiscoveryQuery(new URLSearchParams());
      const sort = buildMarketplaceSort(sortType);
      
      const docs = await collection
        .find(query)
        .sort(sort)
        .limit(2)
        .toArray();

      if (docs.length > 0) {
        const lastDoc = docs[docs.length - 1];
        const cursorData = { _id: lastDoc._id.toString() };
        
        // Add sort-specific fields
        if (sort.createdAt) {
          cursorData.createdAt = lastDoc.createdAt.toISOString();
        }
        if (sort.price) {
          cursorData.price = lastDoc.price;
        }
        if (sort.rating) {
          cursorData.rating = lastDoc.rating || 0;
        }
        if (sort.likes) {
          cursorData.likes = lastDoc.likes || 0;
        }

        const cursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
        
        // Should be able to decode without errors
        expect(() => {
          JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
        }).not.toThrow();
      }
    }
  });

  test('API backwards compatibility with page parameter', async () => {
    // The API should still work with the old page parameter
    const searchParams = new URLSearchParams({
      page: '2',
      pageSize: '12',
      sortBy: 'newest'
    });

    // This would normally be tested via HTTP request, but we can test the parsing logic
    const { parsePagination } = await import('../src/lib/api/validation.js');
    const pagination = parsePagination(searchParams);
    
    expect(pagination.page).toBe(2);
    expect(pagination.pageSize).toBe(12);
    expect(pagination.paginationType).toBe('offset');
  });

  test('Cursor parameter takes precedence over page parameter', async () => {
    const testCursor = Buffer.from(JSON.stringify({
      _id: new ObjectId().toString(),
      createdAt: new Date().toISOString()
    })).toString('base64');

    const searchParams = new URLSearchParams({
      page: '5',
      cursor: testCursor,
      pageSize: '12'
    });

    const { parsePagination } = await import('../src/lib/api/validation.js');
    const pagination = parsePagination(searchParams);
    
    expect(pagination.cursor).toBe(testCursor);
    expect(pagination.paginationType).toBe('cursor');
    expect(pagination.page).toBeUndefined();
  });
});

// Benchmark runner for manual performance testing
async function runBenchmark() {
  console.log('🚀 Running pagination performance benchmark...\n');
  
  const db = await getDb();
  const collection = db.collection('materials');
  
  const query = {
    visibility: 'public',
    archived: { $ne: true },
    moderationStatus: { $ne: 'suspended' },
    isDeleted: { $ne: true },
    creatorSuspended: { $ne: true }
  };
  
  const sort = { createdAt: -1 };
  const pageSize = 12;
  
  console.log('--- Offset Pagination (Page 100) ---');
  const offsetStart = performance.now();
  await collection
    .find(query)
    .sort(sort)
    .skip(99 * pageSize)
    .limit(pageSize)
    .toArray();
  const offsetTime = performance.now() - offsetStart;
  
  console.log('--- Cursor Pagination (Equivalent Position) ---');
  // Get a reference document at the same position
  const refDoc = await collection
    .findOne(query, { sort, skip: 99 * pageSize });
  
  if (refDoc) {
    const cursorQuery = {
      ...query,
      createdAt: { $lt: refDoc.createdAt }
    };
    
    const cursorStart = performance.now();
    await collection
      .find(cursorQuery)
      .sort(sort)
      .limit(pageSize)
      .toArray();
    const cursorTime = performance.now() - cursorStart;
    
    const improvement = ((offsetTime - cursorTime) / offsetTime * 100).toFixed(1);
    
    console.log(`Offset time: ${offsetTime.toFixed(2)}ms`);
    console.log(`Cursor time: ${cursorTime.toFixed(2)}ms`);
    console.log(`Improvement: ${improvement}% faster with cursor pagination`);
  }
}

// Export benchmark for manual testing
export { runBenchmark };