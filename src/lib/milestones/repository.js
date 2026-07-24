import { COLLECTIONS } from "../backend/schemaContracts.js";

const FINAL_STATUSES = new Set(["paid"]);

function transitionId({ milestoneId, toStatus, version }) {
  return `${milestoneId}:v${version}:${toStatus}`;
}

export async function listPayoutMilestones(db, payoutId) {
  const normalized = await db
    .collection(COLLECTIONS.milestones)
    .find({
      payoutId,
    })
    .sort({
      position: 1,
    })
    .toArray();

  if (normalized.length > 0) {
    return normalized;
  }

  const payout = await db
    .collection(COLLECTIONS.payouts)
    .findOne({
      payoutId,
    });

  return Array.isArray(payout?.milestones) ? payout.milestones : [];
}

export async function transitionMilestoneStatus(
  db,
  {
    milestoneId,
    expectedVersion,
    toStatus,
    actorId = null,
    reason = null,
    evidence = [],
    now = new Date(),
  },
) {
  if (!milestoneId) {
    throw new Error("milestoneId is required");
  }

  if (!toStatus) {
    throw new Error("toStatus is required");
  }

  const milestones = db.collection(COLLECTIONS.milestones);
  const current = await milestones.findOne({
    milestoneId,
  });

  if (!current) {
    throw new Error(`Milestone ${milestoneId} not found`);
  }

  if (FINAL_STATUSES.has(current.status) && current.status !== toStatus) {
    throw new Error(`Milestone ${milestoneId} is final and cannot transition from ${current.status}`);
  }

  const nextVersion = Number(current.version || 1) + 1;
  const filter = {
    milestoneId,
    version: expectedVersion ?? current.version ?? 1,
  };

  const updateResult = await milestones.updateOne(
    filter,
    {
      $set: {
        status: toStatus,
        updatedAt: now,
      },
      $inc: {
        version: 1,
      },
    },
  );

  if (updateResult.matchedCount !== 1) {
    const error = new Error(`Concurrent milestone update detected for ${milestoneId}`);
    error.code = "MILESTONE_VERSION_CONFLICT";
    throw error;
  }

  await db.collection(COLLECTIONS.milestoneTransitions).updateOne(
    {
      transitionId: transitionId({
        milestoneId,
        toStatus,
        version: nextVersion,
      }),
    },
    {
      $setOnInsert: {
        transitionId: transitionId({
          milestoneId,
          toStatus,
          version: nextVersion,
        }),
        milestoneId,
        payoutId: current.payoutId,
        fromStatus: current.status,
        toStatus,
        actorId,
        reason,
        source: "api",
        createdAt: now,
      },
    },
    {
      upsert: true,
    },
  );

  for (const [index, item] of evidence.entries()) {
    await db.collection(COLLECTIONS.milestoneEvidence).updateOne(
      {
        evidenceId: item.evidenceId || `${milestoneId}:transition:${nextVersion}:${index}`,
      },
      {
        $setOnInsert: {
          evidenceId: item.evidenceId || `${milestoneId}:transition:${nextVersion}:${index}`,
          milestoneId,
          payoutId: current.payoutId,
          type: item.type || "link",
          uri: item.uri || null,
          label: item.label || null,
          metadata: item.metadata || null,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        upsert: true,
      },
    );
  }

  return milestones.findOne({
    milestoneId,
  });
}
