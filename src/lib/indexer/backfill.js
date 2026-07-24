import { applyIndexedEvent, eventId } from "./stellarIndexer.js";

export async function backfillLedgerRange({ db, eventSource, network, contractIds, startLedger, endLedger, dryRun = true, repair = false, jobId = "manual", pageSize = 100 }) {
  if (!network || !contractIds?.length) throw new Error("network and contractIds are required");
  if (!Number.isInteger(startLedger) || !Number.isInteger(endLedger) || startLedger > endLedger) throw new Error("invalid ledger range");

  const checkpoints = db.collection("indexer_backfill_checkpoints");
  const reports = db.collection("indexer_reconciliation_reports");
  const checkpoint = await checkpoints.findOne({ _id: jobId });
  let cursor = checkpoint?.cursor || null;
  const report = { jobId, schemaVersion: 1, network, contractIds, startLedger, endLedger, dryRun, scanned: 0, missing: [], divergent: [], duplicate: [], startedAt: new Date() };

  do {
    const page = await eventSource.getEvents({ cursor, limit: pageSize, startLedger, endLedger, contractIds });
    let reachedEnd = false;
    for (const event of page.events || []) {
      if (Number(event.ledger) > endLedger) { reachedEnd = true; continue; }
      report.scanned += 1;
      const id = eventId(event);
      const indexed = await db.collection("sync_events").findOne({ _id: id });
      if (!indexed) {
        report.missing.push(id);
        if (repair && !dryRun) await applyIndexedEvent(db, event);
      } else if (JSON.stringify(indexed.raw) !== JSON.stringify(event)) {
        report.divergent.push(id); // audited only: never overwrite or delete silently
      } else {
        report.duplicate.push(id);
      }
    }
    cursor = reachedEnd ? null : (page.nextCursor || null);
    await checkpoints.updateOne(
      { _id: jobId },
      { $set: { cursor, lastLedger: page.lastLedger || null, updatedAt: new Date(), manifest: { schemaVersion: 1, network, contractIds, startLedger, endLedger } }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true },
    );
  } while (cursor);

  report.finishedAt = new Date();
  await reports.insertOne(report);
  return report;
}
