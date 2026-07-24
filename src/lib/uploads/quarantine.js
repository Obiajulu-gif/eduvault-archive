import { createHash } from "node:crypto";

export const SCAN_STATUS = Object.freeze({ QUARANTINED: "quarantined", SCANNING: "scanning", APPROVED: "approved", REJECTED: "rejected", FAILED: "scan_failed" });

export async function quarantineUpload(db, { bytes, fileName, mimeType, metadata = {} }) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const duplicate = await db.collection("upload_quarantine").findOne({ sha256, status: { $in: [SCAN_STATUS.QUARANTINED, SCAN_STATUS.SCANNING, SCAN_STATUS.APPROVED] } });
  if (duplicate) return duplicate;
  const record = {
    sha256, fileName, mimeType, metadata, payload: bytes,
    status: SCAN_STATUS.QUARANTINED, attempts: 0, createdAt: new Date(), updatedAt: new Date(),
  };
  const result = await db.collection("upload_quarantine").insertOne(record);
  return { ...record, _id: result.insertedId };
}

export async function scanNextUpload(db, scanner, { workerId, leaseMs = 60_000, engineVersion, rulesVersion }) {
  const now = new Date();
  const job = await db.collection("upload_quarantine").findOneAndUpdate(
    { status: { $in: [SCAN_STATUS.QUARANTINED, SCAN_STATUS.FAILED] }, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: now } }] },
    { $set: { status: SCAN_STATUS.SCANNING, workerId, leaseUntil: new Date(now.getTime() + leaseMs), updatedAt: now }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  );
  if (!job) return null;
  try {
    const result = await scanner.scan(Buffer.from(job.payload.buffer || job.payload));
    const unsafeArchive = result.archiveEntries > 1000 || result.expandedBytes > 100 * 1024 * 1024 || result.maxDepth > 5;
    const status = result.clean && !unsafeArchive ? SCAN_STATUS.APPROVED : SCAN_STATUS.REJECTED;
    await db.collection("upload_quarantine").updateOne({ _id: job._id, workerId }, { $set: { status, verdict: unsafeArchive ? "unsafe_archive" : result.verdict, engineVersion, rulesVersion, scannedAt: new Date(), updatedAt: new Date() }, $unset: { payload: "", leaseUntil: "", workerId: "" } });
    return { id: job._id, status };
  } catch (error) {
    await db.collection("upload_quarantine").updateOne({ _id: job._id, workerId }, { $set: { status: SCAN_STATUS.FAILED, lastError: String(error?.message || error), updatedAt: new Date() }, $unset: { leaseUntil: "", workerId: "" } });
    return { id: job._id, status: SCAN_STATUS.FAILED };
  }
}
