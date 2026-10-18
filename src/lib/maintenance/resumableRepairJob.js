/**
 * Resumable, operator-authorized repair runner for inconsistent records.
 *
 * A repair is deliberately an explicit replacement. This keeps dry-runs,
 * retries, and audit records deterministic and avoids partial field updates.
 */

export class RepairAuthorizationError extends Error {
  constructor() {
    super("An authorized operator is required to run a repair job");
    this.name = "RepairAuthorizationError";
    this.status = 403;
  }
}

function assertAuthorized(authorize, actor) {
  if (typeof authorize !== "function" || authorize(actor) !== true) {
    throw new RepairAuthorizationError();
  }
}

export async function runResumableRepair({
  db,
  collectionName,
  jobId,
  query = {},
  repair,
  authorize,
  actor,
  validate = () => true,
  batchSize = 100,
  maxBatches = Infinity,
  dryRun = false,
  checkpointCollectionName = "repair_checkpoints",
  now = () => new Date(),
} = {}) {
  assertAuthorized(authorize, actor);
  if (!db || !collectionName || !jobId || typeof repair !== "function") {
    throw new TypeError("db, collectionName, jobId, and repair are required");
  }

  const collection = db.collection(collectionName);
  const checkpoints = db.collection(checkpointCollectionName);
  const checkpoint = await checkpoints.findOne({ _id: jobId });
  let lastProcessedId = checkpoint?.lastProcessedId ?? null;
  let processed = checkpoint?.processed ?? 0;
  let repaired = checkpoint?.repaired ?? 0;
  let batches = 0;
  const samples = [];

  while (batches < Math.max(1, Number(maxBatches) || 1)) {
    const batchQuery = { ...query };
    if (lastProcessedId !== null) batchQuery._id = { $gt: lastProcessedId };
    const docs = await collection.find(batchQuery).sort({ _id: 1 }).limit(Math.max(1, Number(batchSize) || 1)).toArray();
    if (docs.length === 0) break;
    batches += 1;

    for (const doc of docs) {
      const result = await repair(doc);
      if (!result || typeof result !== "object") throw new TypeError("repair must return an object");
      if (result.changed === true) {
        if (!validate(result.document, doc)) throw new Error(`Repair validation failed for ${String(doc._id)}`);
        if (samples.length < 10) samples.push({ id: String(doc._id), reason: result.reason ?? null });
        if (!dryRun) await collection.replaceOne({ _id: doc._id }, result.document);
        repaired += 1;
      }
      processed += 1;
      lastProcessedId = doc._id;
    }

    if (!dryRun) {
      await checkpoints.updateOne(
        { _id: jobId },
        { $set: { lastProcessedId, processed, repaired, completed: false, updatedAt: now() } },
        { upsert: true },
      );
    }
  }

  const remaining = await collection.countDocuments({ ...query, ...(lastProcessedId === null ? {} : { _id: { $gt: lastProcessedId } }) });
  const completed = remaining === 0;
  if (!dryRun) {
    await checkpoints.updateOne(
      { _id: jobId },
      { $set: { lastProcessedId, processed, repaired, completed, updatedAt: now(), ...(completed ? { completedAt: now() } : {}) } },
      { upsert: true },
    );
  }
  return { jobId, dryRun, processed, repaired: dryRun ? 0 : repaired, completed, remaining, samples };
}
