import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeLegacyPayoutMilestones,
  sumMilestoneAmounts,
} from "../../src/lib/milestones/normalization.js";
import {
  listPayoutMilestones,
  transitionMilestoneStatus,
} from "../../src/lib/milestones/repository.js";
import migration004 from "../../src/lib/backend/migrations/004-normalize-payout-milestones.js";
import { createFakeDb } from "./helpers/fakeMongo.mjs";

test("normalizes legacy payout milestone JSON with evidence and exceptions", () => {
  const result = normalizeLegacyPayoutMilestones({
    payoutId: "payout-1",
    escrowId: "escrow-1",
    amount: "100",
    asset: "usdc",
    milestones: JSON.stringify([
      {
        id: "design",
        title: "Design",
        amount: "40",
        status: "accepted",
        dueDate: "2026-08-01T00:00:00.000Z",
        evidenceUrl: "ipfs://evidence",
      },
      {
        title: "Build",
        amount: "not-money",
        status: "in_review",
      },
      null,
    ]),
  });

  assert.equal(result.sourceCount, 3);
  assert.equal(result.milestones.length, 2);
  assert.equal(result.milestones[0].milestoneId, "payout-1:design");
  assert.equal(result.milestones[0].position, 0);
  assert.equal(result.milestones[0].status, "approved");
  assert.equal(result.milestones[0].currency, "USDC");
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].uri, "ipfs://evidence");
  assert.deepEqual(
    result.exceptions.map((exception) => exception.reason),
    ["invalid_amount", "malformed_milestone"],
  );
  assert.equal(sumMilestoneAmounts(result.milestones), 40);
});

test("normalizer reports malformed milestone payloads without throwing", () => {
  const result = normalizeLegacyPayoutMilestones({
    payoutId: "payout-2",
    escrowId: "escrow-2",
    milestones: "{bad json",
  });

  assert.equal(result.sourceCount, 0);
  assert.equal(result.milestones.length, 0);
  assert.equal(result.exceptions.length, 1);
  assert.equal(result.exceptions[0].reason, "malformed_json");
});

test("listPayoutMilestones dual-reads normalized rows before legacy JSON", async () => {
  const db = createFakeDb();

  await db.collection("payouts").insertOne({
    payoutId: "payout-3",
    escrowId: "escrow-3",
    milestones: [
      {
        title: "Legacy",
      },
    ],
  });

  assert.equal((await listPayoutMilestones(db, "payout-3"))[0].title, "Legacy");

  await db.collection("milestones").insertOne({
    milestoneId: "payout-3:1",
    payoutId: "payout-3",
    escrowId: "escrow-3",
    position: 1,
    status: "pending",
    title: "Second",
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.collection("milestones").insertOne({
    milestoneId: "payout-3:0",
    payoutId: "payout-3",
    escrowId: "escrow-3",
    position: 0,
    status: "pending",
    title: "First",
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const rows = await listPayoutMilestones(db, "payout-3");
  assert.deepEqual(rows.map((row) => row.title), ["First", "Second"]);
});

test("transitionMilestoneStatus rejects stale expected versions", async () => {
  const db = createFakeDb();

  await db.collection("milestones").insertOne({
    milestoneId: "payout-4:0",
    payoutId: "payout-4",
    escrowId: "escrow-4",
    position: 0,
    status: "pending",
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const updated = await transitionMilestoneStatus(db, {
    milestoneId: "payout-4:0",
    expectedVersion: 1,
    toStatus: "submitted",
    actorId: "GACTOR",
    evidence: [
      {
        uri: "ipfs://submission",
      },
    ],
  });

  assert.equal(updated.status, "submitted");
  assert.equal(updated.version, 2);
  assert.equal(db.dump("milestone_transitions").length, 1);
  assert.equal(db.dump("milestone_evidence").length, 1);

  await assert.rejects(
    transitionMilestoneStatus(db, {
      milestoneId: "payout-4:0",
      expectedVersion: 1,
      toStatus: "approved",
    }),
    (error) => error.code === "MILESTONE_VERSION_CONFLICT",
  );
});

test("migration 004 backfills milestones idempotently and records exceptions", async () => {
  const db = createFakeDb();
  let checkpoint = null;

  await db.collection("payouts").insertOne({
    _id: "payout-5",
    payoutId: "payout-5",
    escrowId: "escrow-5",
    amount: "75",
    asset: "USDC",
    milestones: [
      {
        title: "Draft",
        amount: "25",
        status: "pending",
      },
      {
        title: "Review",
        amount: "50",
        status: "approved",
        evidence: [
          {
            uri: "ipfs://review",
          },
        ],
      },
      "bad-row",
    ],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });

  const context = {
    db,
    logger: {
      info() {},
    },
    async getCheckpoint() {
      return checkpoint;
    },
    async saveCheckpoint(value) {
      checkpoint = value;
    },
    async clearCheckpoint() {
      checkpoint = null;
    },
  };

  await migration004.up(context);
  await migration004.up(context);

  const milestones = db.dump("milestones");
  assert.equal(milestones.length, 2);
  assert.deepEqual(
    milestones.map((milestone) => milestone.position),
    [0, 1],
  );
  assert.equal(db.dump("milestone_evidence").length, 1);
  assert.equal(db.dump("milestone_transitions").length, 2);

  const exceptions = db.dump("milestone_migration_exceptions");
  assert.equal(exceptions.length, 1);
  assert.equal(exceptions[0].reason, "malformed_milestone");

  const payout = db.dump("payouts")[0];
  assert.equal(payout.milestoneBackfill.sourceCount, 3);
  assert.equal(payout.milestoneBackfill.targetCount, 2);
  assert.equal(payout.milestoneBackfill.amountTotal, "75");
  assert.equal(checkpoint, null);
});
