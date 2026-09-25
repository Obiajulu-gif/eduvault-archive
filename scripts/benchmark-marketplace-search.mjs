import { randomUUID } from "node:crypto";
import { getDb } from "../src/lib/mongodb.js";

const SIZE = Number(process.env.MARKETPLACE_BENCHMARK_SIZE || 100_000);
const collectionName = `marketplace_benchmark_${randomUUID().replaceAll("-", "")}`;
const started = performance.now();

const db = await getDb();
const collection = db.collection(collectionName);

try {
  const now = Date.now();
  const documents = Array.from({ length: SIZE }, (_, index) => ({
    visibility: "public",
    category: index % 5 === 0 ? "Science" : "Programming",
    subject: index % 3 === 0 ? "Mathematics" : "Computer Science",
    price: index % 100,
    rating: (index % 50) / 10,
    likes: index % 2000,
    title: `Benchmark material ${index}`,
    description: "Representative educational marketplace listing",
    createdAt: new Date(now - (index % 365) * 86_400_000),
  }));

  const insertStarted = performance.now();
  await collection.insertMany(documents, { ordered: false });
  const insertMs = performance.now() - insertStarted;

  const indexStarted = performance.now();
  await collection.createIndex({ visibility: 1, category: 1, price: 1, createdAt: -1 });
  await collection.createIndex({ visibility: 1, category: 1, rating: -1, createdAt: -1 });
  const indexMs = performance.now() - indexStarted;

  const query = { visibility: "public", category: "Science", price: { $gte: 20, $lte: 80 } };
  const queryStarted = performance.now();
  const explain = await collection.find(query).sort({ createdAt: -1 }).limit(24).explain("executionStats");
  const queryMs = performance.now() - queryStarted;
  const stats = explain.executionStats;

  console.log(JSON.stringify({
    collection: collectionName,
    documents: SIZE,
    insertMs: Number(insertMs.toFixed(2)),
    indexMs: Number(indexMs.toFixed(2)),
    queryMs: Number(queryMs.toFixed(2)),
    totalKeysExamined: stats.totalKeysExamined,
    totalDocsExamined: stats.totalDocsExamined,
    nReturned: stats.nReturned,
    winningPlan: stats.executionStages?.stage || null,
  }, null, 2));
} finally {
  await collection.drop().catch(() => {});
}
