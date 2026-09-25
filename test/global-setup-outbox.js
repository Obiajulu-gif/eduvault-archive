// Global setup for tests/backend/outbox.test.js.
//
// src/lib/mongodb.js reads `process.env.MONGODB_URI` into a module-level
// `const` at import time, so setting the env var inside a test's
// `beforeEach` (after the module has already been imported) has no effect —
// this is exactly why outbox.test.js never actually connected when it was
// finally wired into the vitest run (see issue #635). Vitest's `globalSetup`
// runs before any test file (and therefore before src/lib/mongodb.js) is
// imported, so the env var is in place in time here.
import { MongoMemoryServer } from "mongodb-memory-server";

export default async function setup() {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.MONGODB_DB = "test";

  return async () => {
    await mongod.stop();
  };
}
