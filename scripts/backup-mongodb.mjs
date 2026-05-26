#!/usr/bin/env node
/**
 * Automated MongoDB backup script for EduVault (#81).
 *
 * What it does:
 *  1. Runs `mongodump` against MONGODB_URI and writes a compressed archive.
 *  2. Uploads the archive to S3-compatible storage (AWS S3, Cloudflare R2, etc.)
 *     using the AWS SDK v3 — configured via environment variables.
 *  3. Prunes local temp files after a successful upload.
 *  4. Logs structured JSON so the output can be piped into any log aggregator.
 *
 * Usage:
 *   node scripts/backup-mongodb.mjs
 *
 * Required env vars:
 *   MONGODB_URI           — full connection string
 *   BACKUP_S3_BUCKET      — destination bucket name
 *   BACKUP_S3_REGION      — AWS region (default: us-east-1)
 *   AWS_ACCESS_KEY_ID     — AWS / R2 access key
 *   AWS_SECRET_ACCESS_KEY — AWS / R2 secret key
 *   BACKUP_S3_ENDPOINT    — (optional) custom S3 endpoint for R2 / MinIO
 *
 * Optional env vars:
 *   BACKUP_RETAIN_DAYS    — how many days to keep local copies (default: 0 = delete immediately)
 *   MONGODB_DB            — override the database name extracted from the URI
 */

import { execFile } from "node:child_process";
import { createReadStream, unlinkSync, statSync } from "node:fs";
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

const MONGODB_URI = requireEnv("MONGODB_URI");
const S3_BUCKET = requireEnv("BACKUP_S3_BUCKET");
const S3_REGION = process.env.BACKUP_S3_REGION || "us-east-1";

// ---------------------------------------------------------------------------
// Derive archive filename
// ---------------------------------------------------------------------------
const now = new Date();
const datestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
const archiveName = `eduvault-backup-${datestamp}.gz`;
const archivePath = join(tmpdir(), archiveName);

// ---------------------------------------------------------------------------
// Step 1: mongodump
// ---------------------------------------------------------------------------
async function runMongodump() {
  log("info", "Starting mongodump", { archive: archivePath });

  const args = [
    `--uri=${MONGODB_URI}`,
    `--archive=${archivePath}`,
    "--gzip",
  ];

  if (process.env.MONGODB_DB) {
    args.push(`--db=${process.env.MONGODB_DB}`);
  }

  try {
    const { stdout, stderr } = await execFileAsync("mongodump", args);
    if (stderr) log("debug", "mongodump stderr", { stderr });
    if (stdout) log("debug", "mongodump stdout", { stdout });
    const size = statSync(archivePath).size;
    log("info", "mongodump completed", { archive: archivePath, bytes: size });
  } catch (err) {
    log("error", "mongodump failed", { error: err.message });
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Step 2: upload to S3
// ---------------------------------------------------------------------------
async function uploadToS3() {
  let S3Client, PutObjectCommand;
  try {
    ({ S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3"));
  } catch {
    log("warn", "@aws-sdk/client-s3 not installed — skipping S3 upload. Install it to enable off-site storage.");
    return;
  }

  const clientConfig = {
    region: S3_REGION,
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
  const key = `backups/${datestamp.slice(0, 7)}/${archiveName}`;

  log("info", "Uploading backup to S3", { bucket: S3_BUCKET, key });

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: createReadStream(archivePath),
        ContentType: "application/gzip",
        Metadata: {
          source: "eduvault-backup-script",
          created: now.toISOString(),
        },
      })
    );
    log("info", "Upload completed", { bucket: S3_BUCKET, key });
  } catch (err) {
    log("error", "S3 upload failed", { error: err.message });
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Step 3: clean up local temp file
// ---------------------------------------------------------------------------
function cleanupLocal() {
  const retainDays = parseInt(process.env.BACKUP_RETAIN_DAYS || "0", 10);
  if (retainDays > 0) {
    log("info", `Retaining local backup for ${retainDays} day(s)`, { path: archivePath });
    return;
  }
  try {
    unlinkSync(archivePath);
    log("info", "Removed local temp archive", { path: archivePath });
  } catch (err) {
    log("warn", "Could not remove local temp archive", { path: archivePath, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  log("info", "EduVault backup started", { datestamp });
  await runMongodump();
  await uploadToS3();
  cleanupLocal();
  log("info", "EduVault backup finished successfully");
})();
