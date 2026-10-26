import assert from "node:assert/strict";
import { test } from "node:test";
import { DisputeState, TransferState, openTransferDispute, addDisputeEvidence, resolveTransferDispute, assertTransferNotDisputed } from "../ownershipTransfer.js";

function collection(docs = []) {
  return {
    docs,
    async findOne(query) { return docs.find((doc) => Object.entries(query).every(([key, value]) => key === "state" && value?.$in ? value.$in.includes(doc.state) : String(doc[key]) === String(value))) || null; },
    async insertOne(doc) { docs.push(doc); return { insertedId: doc._id }; },
    async findOneAndUpdate(query, update) { const doc = await this.findOne(query); if (!doc) return null; Object.assign(doc, update.$set || {}); if (update.$push) for (const [key, value] of Object.entries(update.$push)) (doc[key] ||= []).push(value); return doc; },
  };
}
function db() { const transfers = collection([{ _id: "t1", fromAddress: "owner", toAddress: "recipient", state: TransferState.ACCEPTED }]); const disputes = collection(); return { collection(name) { return name === "ownership_transfers" ? transfers : disputes; } }; }

test("valid dispute records evidence and blocks destructive transfer actions", async () => {
  const database = db();
  const opened = await openTransferDispute(database, { transferId: "t1", actor: { id: "owner" }, reason: "Fraudulent transfer", evidence: [{ type: "ticket", reference: "case-1" }] });
  assert.equal(opened.dispute.state, DisputeState.OPEN);
  await assert.rejects(() => assertTransferNotDisputed(database, "t1"), /on hold/);
  const withEvidence = await addDisputeEvidence(database, { disputeId: opened.dispute._id, actor: "owner", evidence: { type: "hash", reference: "tx-1" } });
  assert.equal(withEvidence.evidence.length, 2);
});

test("admin resolutions are audited and release the hold", async () => {
  const database = db();
  const opened = await openTransferDispute(database, { transferId: "t1", actor: { id: "recipient" }, reason: "Mistaken transfer" });
  const resolved = await resolveTransferDispute(database, { disputeId: opened.dispute._id, actor: { id: "admin", role: "admin" }, resolution: DisputeState.RESOLVED_REJECTED, reason: "Evidence insufficient" });
  assert.equal(resolved.dispute.state, DisputeState.RESOLVED_REJECTED);
  await assertTransferNotDisputed(database, "t1");
});

test("invalid parties and resolutions are rejected", async () => {
  const database = db();
  await assert.rejects(() => openTransferDispute(database, { transferId: "t1", actor: "stranger", reason: "No" }), /Only a transfer party/);
  const opened = await openTransferDispute(database, { transferId: "t1", actor: { id: "owner" }, reason: "Valid reason" });
  await assert.rejects(() => resolveTransferDispute(database, { disputeId: opened.dispute._id, actor: { role: "support" }, resolution: DisputeState.RESOLVED_ACCEPTED }), /Only an admin/);
});
