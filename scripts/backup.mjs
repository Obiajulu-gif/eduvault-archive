#!/usr/bin/env node
/**
 * New, comprehensive backup script for EduVault.
 *
 * What it does:
 *  1. Executes `create-backup-manifest.mjs` to generate a state manifest.
 *  2. Runs `mongodump` to create a binary database archive.
 *  3. Bundles the manifest and the database dump into a single .tar.gz file.
 *  4. Encrypts the bundle using AES-256-GCM with a key from the environment.
 *  5. Uploads the final encrypted archive to S3-compatible storage.
 *  6. Cleans up all local temporary files.
 */

import { execFile } from "node:child_process";
import { createReadStream, unlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------
function log(level, message, extra = {}) {
  console.log(JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...extra }));
}

// ---------------------------------------------------------------------------
// Validate environment
// ---------------------------------------------------------------------------
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    log("error", `Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runBackup() {
  const MONGODB_URI = requireEnv("MONGODB_URI");
  const ENCRYPTION_KEY = requireEnv("BACKUP_ENCRYPTION_KEY");
  const S3_BUCKET = requireEnv("BACKUP_S3_BUCKET");

  const now = new Date();
  const datestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const tempDir = tmpdir();

  // --- File Paths ---
  const manifestPath = join(tempDir, `manifest-${datestamp}.json`);
  const mongoDumpPath = join(tempDir, `eduvault-mongo-${datestamp}.gz`);
  const bundlePath = join(tempDir, `eduvault-backup-${datestamp}.tar.gz`);
  const encryptedBundlePath = bundlePath + ".enc";

  log("info", "EduVault backup started", { datestamp });

  // Step 1: Create Manifest
  try {
    log("info", "Generating backup manifest...");
    const { stdout } = await execFileAsync("node", ["scripts/create-backup-manifest.mjs"]);
    writeFileSync(manifestPath, stdout);
    log("info", "Manifest generated successfully", { path: manifestPath });
  } catch (err) {
    log("error", "Failed to generate manifest", { error: err.message, stderr: err.stderr });
    process.exit(1);
  }

  const { createGzip } = require("node:zlib");
const { pipeline } = require("node:stream/promises");
const crypto = require("node:crypto");

// ... (logging and env validation)

// ---------------------------------------------------------------------------
// Step 2: mongodump
// ---------------------------------------------------------------------------
async function runMongodump(uri, path) {
  log("info", "Starting mongodump", { archive: path });
  const args = [`--uri=${uri}`, `--archive=${path}`, "--gzip"];
  if (process.env.MONGODB_DB) {
    args.push(`--db=${process.env.MONGODB_DB}`);
  }
  try {
    await execFileAsync("mongodump", args);
    const size = statSync(path).size;
    log("info", "mongodump completed", { archive: path, bytes: size });
  } catch (err) {
    log("error", "mongodump failed", { error: err.message, stderr: err.stderr });
    throw err; // Re-throw to be caught by main try/catch
  }
}

// ---------------------------------------------------------------------------
// Step 3: Bundle artifacts
// ---------------------------------------------------------------------------
async function createBundle(bundlePath, files) {
    log("info", "Creating backup bundle", { bundle: bundlePath, files });
    // Using tar command to create a gzipped tarball
    const tarFiles = files.map(f => f.split('\\').pop());
    const cwd = files[0].substring(0, files[0].lastIndexOf('\\'));
    try {
        await execFileAsync("tar", ["-czvf", bundlePath, ...tarFiles], { cwd });
        const size = statSync(bundlePath).size;
        log("info", "Bundle created successfully", { bundle: bundlePath, bytes: size });
    } catch (err) {
        log("error", "Failed to create bundle", { error: err.message, stderr: err.stderr });
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Step 4: Encrypt the bundle
// ---------------------------------------------------------------------------
async function encryptBundle(inputPath, outputPath, key) {
  log("info", "Encrypting bundle", { input: inputPath, output: outputPath });
  const iv = crypto.randomBytes(12); // GCM standard IV size
  const salt = crypto.randomBytes(64);
  const authTagLength = 16;

  const derivedKey = crypto.pbkdf2Sync(key, salt, 100000, 32, "sha512");
  const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey, iv);

  const input = createReadStream(inputPath);
  const output = createWriteStream(outputPath);

  output.write(salt);
  output.write(iv);

  await pipeline(input, cipher, output);

  const authTag = cipher.getAuthTag();
  output.end(authTag);

  log("info", "Encryption complete", { output: outputPath });
}

// ---------------------------------------------------------------------------
// Step 5: Upload to S3
// ---------------------------------------------------------------------------
async function uploadToS3(bucket, key, path) {
  let S3Client, PutObjectCommand;
  try {
    ({ S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3"));
  } catch {
    log("warn", "@aws-sdk/client-s3 not installed — skipping S3 upload. Install it to enable off-site storage.");
    return;
  }

  const clientConfig = {
    region: process.env.BACKUP_S3_REGION || "us-east-1",
    credentials: {
      accessKeyId: requireEnv("AWS_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("AWS_SECRET_ACCESS_KEY"),
    },
  };
  if (process.env.BACKUP_S3_ENDPOINT) {
    clientConfig.endpoint = process.env.BACKUP_S3_ENDPOINT;
    clientConfig.forcePathStyle = true;
  }

  const client = new S3Client(clientConfig);

  log("info", "Uploading backup to S3", { bucket, key });

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(path),
        ContentType: "application/octet-stream", // It's an encrypted binary file
        Metadata: {
          source: "eduvault-backup-script",
          created: new Date().toISOString(),
        },
      })
    );
    log("info", "Upload completed", { bucket, key });
    console.log(`::set-output name=s3_key::${key}`);
  } catch (err) {
    log("error", "S3 upload failed", { error: err.message });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Step 6: Cleanup
// ---------------------------------------------------------------------------
function cleanup(files) {
  log("info", "Cleaning up temporary files", { files });
  files.forEach(file => {
    try {
      unlinkSync(file);
    } catch (err) {
      log("warn", "Failed to delete temp file", { file, error: err.message });
    }
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runBackup() {
  // ... (env validation and path setup)

  const filesToCleanup = [];

  try {
    // ... (Step 1: Create Manifest)
    filesToCleanup.push(manifestPath);

    // Step 2: Run mongodump
    await runMongodump(MONGODB_URI, mongoDumpPath);
    filesToCleanup.push(mongoDumpPath);

    // Step 3: Bundle manifest and dump
    await createBundle(bundlePath, [manifestPath, mongoDumpPath]);
    filesToCleanup.push(bundlePath);

    // Step 4: Encrypt the bundle
    await encryptBundle(bundlePath, encryptedBundlePath, ENCRYPTION_KEY);
    filesToCleanup.push(encryptedBundlePath);

    // Step 5: Upload to S3
    const s3Key = `backups/${datestamp.slice(0, 7)}/${encryptedBundlePath.split('\\').pop()}`;
    await uploadToS3(S3_BUCKET, s3Key, encryptedBundlePath);

  } catch (err) {
    log("error", "Backup process failed", { error: err.message });
    process.exit(1);
  } finally {
    // Step 6: Cleanup
    cleanup(filesToCleanup);
  }

  log("info", "EduVault backup finished successfully");
}
// ... (main execution)


  log("info", "EduVault backup finished successfully");
}

(async () => {
  try {
    await runBackup();
  } catch (err) {
    log("error", "Backup process failed", { error: err.message });
    process.exit(1);
  }
})();