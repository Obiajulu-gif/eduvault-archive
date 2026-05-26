import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;

const globalForMongo = globalThis;

function getClientPromise() {
  if (!uri) {
    throw new Error("MONGODB_URI is not set in environment variables");
  }

  // Reuse the client across hot reloads in dev, but only connect on demand.
  if (!globalForMongo._mongoClientPromise) {
    const client = new MongoClient(uri);
    globalForMongo._mongoClientPromise = client.connect();
  }

  return globalForMongo._mongoClientPromise;
}

export async function getDb() {
  const client = await getClientPromise();
  // When DB name is in connection string, driver selects it automatically.
  // Otherwise, fallback to "eduvault".
  const dbName = process.env.MONGODB_DB || "eduvault";
  return client.db(dbName);
}
