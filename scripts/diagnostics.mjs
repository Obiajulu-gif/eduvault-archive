/**
 * scripts/diagnostics.mjs
 *
 * Local diagnostics script to verify contributor environment setup.
 * Checks node version, env vars, database connectivity, and test fixtures.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

let failures = 0;

function printPass(msg) {
  console.log(`[PASS] ${msg}`);
}

function printFail(msg, remediation) {
  console.error(`[FAIL] ${msg}`);
  if (remediation) {
    console.error(`       -> Remediation: ${remediation}`);
  }
  failures++;
}

async function runDiagnostics() {
  console.log('\n--- EduVault Local Diagnostics ---\n');

  // 1. Check Node Version
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.replace('v', '').split('.')[0], 10);
  if (majorVersion >= 18) {
    printPass(`Node.js version is ${nodeVersion}`);
  } else {
    printFail(`Node.js version is ${nodeVersion}. Expected >= 18`, 'Please upgrade Node.js to v18 or later.');
  }

  // 2. Check Environment Variables
  const envPath = path.join(rootDir, '.env.local');
  if (fs.existsSync(envPath)) {
    printPass('.env.local file exists');
    dotenv.config({ path: envPath });
  } else {
    printFail('.env.local file is missing', 'Run `cp .env.example .env.local` to create it.');
  }

  const requiredVars = ['NEXT_PUBLIC_APP_URL', 'MONGODB_URI'];
  for (const v of requiredVars) {
    if (process.env[v]) {
      printPass(`Environment variable ${v} is set`);
    } else {
      printFail(`Environment variable ${v} is missing`, `Add ${v} to your .env.local file.`);
    }
  }

  // 3. Check Database Connectivity
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/eduvault';
  const mongoDbName = process.env.MONGODB_DB || 'eduvault';
  
  let client;
  let dbConnected = false;
  try {
    client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    printPass('Successfully connected to MongoDB');
    dbConnected = true;
  } catch (error) {
    printFail('Failed to connect to MongoDB', 'Ensure MongoDB is running (e.g., `docker compose up -d mongodb`).');
  }

  // 4. Check Test Fixtures
  if (dbConnected && client) {
    try {
      const db = client.db(mongoDbName);
      const userCount = await db.collection('users').countDocuments();
      if (userCount > 0) {
        printPass(`Found ${userCount} users in database (test fixtures present)`);
      } else {
        printFail('No users found in database', 'Run `npm run seed:local` to seed the database with test fixtures.');
      }
    } catch (error) {
      printFail('Failed to query database for test fixtures', 'Ensure the database is accessible.');
    } finally {
      await client.close();
    }
  }

  console.log('\n----------------------------------');
  if (failures === 0) {
    console.log('All diagnostics passed! Your environment is ready to go.');
    process.exit(0);
  } else {
    console.error(`${failures} diagnostic check(s) failed. Please review the remediations above.`);
    process.exit(1);
  }
}

runDiagnostics().catch(err => {
  console.error('An unexpected error occurred during diagnostics:', err);
  process.exit(1);
});
