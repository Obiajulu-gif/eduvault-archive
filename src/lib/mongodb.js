// Resolves: Configure efficient MongoDB connection pooling in the Next.js API routes to handle concurrent requests.
import { cpus } from "node:os";
import { MongoClient } from "mongodb";
import { ensureChallengeIndexes } from "./auth/challenge.js";
import { updatePressureSignal } from "./capacity/shed.js";

const globalForMongo = globalThis;

function parsePositiveInteger(value, fallback, variableName) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${variableName} must be a non-negative integer; received "${value}"`);
  }

  return parsed;
}

function getMongoConfiguration() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error("MONGODB_URI is not set in environment variables");
  }

  const cpuCount = Math.max(cpus().length, 1);
  const maxPoolSize = parsePositiveInteger(
    process.env.MONGODB_MAX_POOL_SIZE,
    cpuCount * 5,
    "MONGODB_MAX_POOL_SIZE",
  );
  const minPoolSize = parsePositiveInteger(
    process.env.MONGODB_MIN_POOL_SIZE,
    Math.min(cpuCount, maxPoolSize),
    "MONGODB_MIN_POOL_SIZE",
  );

  if (minPoolSize > maxPoolSize) {
    throw new Error("MONGODB_MIN_POOL_SIZE cannot be greater than MONGODB_MAX_POOL_SIZE");
  }

  return {
    uri,
    dbName: process.env.MONGODB_DB || "eduvault",
    clientOptions: {
      maxPoolSize,
      minPoolSize,
      serverSelectionTimeoutMS: parsePositiveInteger(
        process.env.MONGODB_TIMEOUT_MS,
        5000,
        "MONGODB_TIMEOUT_MS",
      ),
      heartbeatFrequencyMS: parsePositiveInteger(
        process.env.MONGODB_HEARTBEAT_MS,
        10000,
        "MONGODB_HEARTBEAT_MS",
      ),
      maxIdleTimeMS: parsePositiveInteger(
        process.env.MONGODB_MAX_IDLE_TIME_MS,
        30000,
        "MONGODB_MAX_IDLE_TIME_MS",
      ),
      retryReads: true,
      retryWrites: true,
    },
  };
}

export function getMongoClientPromise() {
  if (!globalForMongo._mongoClientPromise) {
    const { uri, clientOptions } = getMongoConfiguration();
    const client = new MongoClient(uri, clientOptions);

    globalForMongo._mongoClient = client;

    try {
      client.on("connectionPoolCreated", () => {
        updatePressureSignal("mongoPoolCreated", true);
      });

      client.on("connectionPoolClosed", () => {
        updatePressureSignal("mongoPoolExhausted", false);
      });
    } catch {
      // Event monitoring is not available in all MongoDB driver environments.
    }

    globalForMongo._mongoClientPromise = client.connect().catch((error) => {
      globalForMongo._mongoClient = null;
      globalForMongo._mongoClientPromise = null;
      updatePressureSignal("mongoPoolExhausted", true);

      console.error("[mongodb] Connection failed", {
        name: error?.name,
        code: error?.code,
        codeName: error?.codeName,
        message: error?.message,
      });

      throw error;
    });
  }

  return globalForMongo._mongoClientPromise;
}

export function getClientPromise() {
  return getMongoClientPromise();
}

export async function getMongoClient() {
  return getMongoClientPromise();
}

export async function getDb() {
  const client = await getMongoClientPromise();
  const { dbName } = getMongoConfiguration();

  return client.db(dbName);
}

export default async function connectToDatabase() {
  const client = await getMongoClientPromise();
  const { dbName } = getMongoConfiguration();

  return {
    client,
    db: client.db(dbName),
  };
}

export async function ensureMongoIndexes() {
  const db = await getDb();
  const collection = db.collection("materials");

  await collection.createIndex(
    { category: 1, price: 1, title: 1, description: 1 },
    { name: "materials_search_compound_idx", background: true },
  );
  await ensureChallengeIndexes(db);
}

export async function pingDatabase() {
  const db = await getDb();
  await db.command({ ping: 1 });
  return true;
}

export async function closeMongoConnection() {
  const client = globalForMongo._mongoClient;

  globalForMongo._mongoClient = null;
  globalForMongo._mongoClientPromise = null;

  if (client) {
    await client.close();
  }
}
