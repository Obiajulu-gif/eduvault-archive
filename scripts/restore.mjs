#!/usr/bin/env node
/**
 * Automated restore and validation script for EduVault.
 *
 * What it does:
 *  1. Downloads an encrypted backup bundle from S3.
 *  2. Decrypts the bundle using a key from the environment.
 *  3. Unpacks the bundle to get the manifest and database dump.
 *  4. Restores the MongoDB database using `mongorestore`.
 *  5. Validates the restored data against the manifest.
 */

import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);

// ... (logger and env validation)

// ---------------------------------------------------------------------------
// Step 1: Download from S3
// ---------------------------------------------------------------------------
async function downloadFromS3(bucket, key, path) {
  let S3Client, GetObjectCommand;
  try {
    ({ S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3"));
  } catch {
    log("warn", "@aws-sdk/client-s3 not installed. Install it to enable S3 functionality.");
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

  log("info", "Downloading backup from S3", { bucket, key });

  try {
    const { Body } = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await pipeline(Body, createWriteStream(path));
    log("info", "Download completed", { path });
  } catch (err) {
    log("error", "S3 download failed", { error: err.message });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Step 2: Decrypt the bundle
// ---------------------------------------------------------------------------
async function decryptBundle(inputPath, outputPath, key) {
  log("info", "Decrypting bundle", { input: inputPath, output: outputPath });

  const input = createReadStream(inputPath);
  const output = createWriteStream(output);

  const salt = await readBytes(input, 64);
  const iv = await readBytes(input, 12);
  const authTag = await readBytes(input, 16, -16); // Read last 16 bytes

  const derivedKey = crypto.pbkdf2Sync(key, salt, 100000, 32, "sha512");
  const decipher = crypto.createDecipheriv("aes-256-gcm", derivedKey, iv);
  decipher.setAuthTag(authTag);

  await pipeline(input, decipher, output);

  log("info", "Decryption complete", { output: outputPath });
}

// Helper to read a specific number of bytes from a stream
function readBytes(stream, numBytes, position = undefined) {
    return new Promise((resolve, reject) => {
        const buffer = Buffer.alloc(numBytes);
        let bytesRead = 0;
        const onReadable = () => {
            let chunk;
            while (null !== (chunk = stream.read(numBytes))) {
                chunk.copy(buffer, bytesRead);
                bytesRead += chunk.length;
                if (bytesRead === numBytes) {
                    stream.removeListener('readable', onReadable);
                    resolve(buffer);
                    return;
                }
            }
        };
        stream.on('readable', onReadable);
        stream.once('error', reject);
    });
}


// ---------------------------------------------------------------------------
// Step 3: Unpack bundle
// ---------------------------------------------------------------------------
async function unpackBundle(bundlePath, targetDir) {
  log("info", "Unpacking bundle", { bundle: bundlePath, targetDir });
  try {
    await execFileAsync("tar", ["-xzf", bundlePath, "-C", targetDir]);
    log("info", "Bundle unpacked successfully");
  } catch (err) {
    log("error", "Failed to unpack bundle", { error: err.message, stderr: err.stderr });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Step 4: Restore database
// ---------------------------------------------------------------------------
async function restoreDatabase(uri, dumpPath) {
  log("info", "Restoring database from dump", { uri, dumpPath });
  try {
    await execFileAsync("mongorestore", [
      `--uri=${uri}`,
      "--drop",
      "--gzip",
      `--archive=${dumpPath}`,
    ]);
    log("info", "Database restored successfully");
  } catch (err) {
    log("error", "Database restore failed", { error: err.message, stderr: err.stderr });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Step 5: Validate restoration
// ---------------------------------------------------------------------------
async function validate(manifest) {
  log("info", "Validating restored data against manifest");
  let validationPassed = true;

  // Validate MongoDB collections
  const { MongoClient } = require("mongodb");
  const client = new MongoClient(requireEnv("MONGODB_URI"));
  try {
    await client.connect();
    const db = client.db(manifest.database.name);
    for (const collectionName in manifest.database.collections) {
      const manifestCollection = manifest.database.collections[collectionName];
      const dbCollection = db.collection(collectionName);
      const count = await dbCollection.countDocuments();
      if (count !== manifestCollection.count) {
        log("error", `Collection count mismatch for ${collectionName}`, {
          manifest: manifestCollection.count,
          restored: count,
        });
        validationPassed = false;
      }
    }
  } finally {
    await client.close();
  }

  // ... (add more validation for IPFS and Soroban)

  if (validationPassed) {
    log("info", "Validation successful: Restored data matches manifest");
  } else {
    log("error", "Validation failed: Restored data does not match manifest");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runRestore() {
  const S3_BUCKET = requireEnv("BACKUP_S3_BUCKET");
  const S3_KEY = requireEnv("BACKUP_S3_KEY"); // The key of the backup to restore
  const ENCRYPTION_KEY = requireEnv("BACKUP_ENCRYPTION_KEY");
  const MONGODB_URI = requireEnv("MONGODB_URI");

  const tempDir = tmpdir();
  const encryptedBundlePath = join(tempDir, S3_KEY.split("/").pop());
  const bundlePath = encryptedBundlePath.replace(".enc", "");
  const unpackedDir = join(tempDir, "unpacked");

  const filesToCleanup = [encryptedBundlePath, bundlePath];

  try {
    // Step 1: Download from S3
    await downloadFromS3(S3_BUCKET, S3_KEY, encryptedBundlePath);

    // Step 2: Decrypt the bundle
    await decryptBundle(encryptedBundlePath, bundlePath, ENCRYPTION_KEY);

    // Step 3: Unpack bundle
    await execFileAsync("mkdir", ["-p", unpackedDir]);
    await unpackBundle(bundlePath, unpackedDir);
    const manifestPath = join(unpackedDir, "manifest.json");
    const mongoDumpPath = join(unpackedDir, "eduvault-mongo.gz"); // This will need to be dynamic

    // Step 4: Restore database
    await restoreDatabase(MONGODB_URI, mongoDumpPath);

    // Step 5: Validate restoration
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    await validate(manifest);

  } catch (err) {
    log("error", "Restore process failed", { error: err.message });
    process.exit(1);
  } finally {
    // Cleanup
    filesToCleanup.forEach(f => {
        try { unlinkSync(f) } catch (e) { /* ignore */ }
    });
    try { execFileAsync("rm", ["-rf", unpackedDir]) } catch(e) { /* ignore */ }
  }

  log("info", "EduVault restore and validation finished successfully");
}

(async () => {
  await runRestore();
})();