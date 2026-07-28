import crypto from 'crypto';
import { getDb } from '@/lib/mongodb';
import { auditLog } from '@/lib/api/audit';

export const MODERATION_POLICY_VERSION = 'v1.0';

export async function createReport(data) {
  const db = await getDb();
  const reports = db.collection('moderation_reports');
  const cases = db.collection('moderation_cases');

  const { materialId, reporterId, reason, evidence } = data;

  // Hash evidence for immutable reference
  const evidenceHash = crypto.createHash('sha256').update(JSON.stringify(evidence || {})).digest('hex');

  // Deduplicate active reports: if a report exists for the same material by this reporter that hasn't been closed
  const existingReport = await reports.findOne({
    materialId,
    reporterId,
    status: { $in: ['open', 'investigating'] }
  });

  if (existingReport) {
    return { success: false, message: 'Active report already exists from this user for this material.', reportId: existingReport._id };
  }

  const reportId = crypto.randomUUID();
  const timestamp = new Date();

  await reports.insertOne({
    _id: reportId,
    materialId,
    reporterId,
    reason,
    evidence,
    evidenceHash,
    status: 'open',
    createdAt: timestamp,
    policyVersion: MODERATION_POLICY_VERSION
  });

  // Check if a case already exists for this material
  let activeCase = await cases.findOne({ materialId, status: { $ne: 'closed' } });

  if (!activeCase) {
    const caseId = crypto.randomUUID();
    await cases.insertOne({
      _id: caseId,
      materialId,
      status: 'open',
      reports: [reportId],
      createdAt: timestamp,
      policyVersion: MODERATION_POLICY_VERSION
    });
    auditLog({ event: 'case_created', materialId, caseId, timestamp });
  } else {
    await cases.updateOne({ _id: activeCase._id }, { $push: { reports: reportId } });
  }

  return { success: true, reportId };
}

export async function proposeSanction(caseId, sanction, proposerId) {
  const db = await getDb();
  const cases = db.collection('moderation_cases');
  const materials = db.collection('materials');

  const modCase = await cases.findOne({ _id: caseId });
  if (!modCase) throw new Error('Case not found');
  if (modCase.status !== 'open' && modCase.status !== 'investigating') {
    throw new Error('Case is not active');
  }

  const material = await materials.findOne({ _id: modCase.materialId });
  if (!material) throw new Error('Material not found');

  // Reviewer conflict check
  if (material.creatorId === proposerId || material.creatorAddress === proposerId) {
    throw new Error('Conflict of interest: Proposer cannot moderate their own material');
  }

  await cases.updateOne({ _id: caseId }, {
    $set: {
      status: 'pending_approval',
      proposedSanction: sanction,
      proposerId,
      proposedAt: new Date()
    }
  });

  auditLog({ event: 'sanction_proposed', caseId, proposerId, sanction });
  return { success: true };
}

export async function approveSanction(caseId, approverId) {
  const db = await getDb();
  const cases = db.collection('moderation_cases');
  const materials = db.collection('materials');

  const modCase = await cases.findOne({ _id: caseId });
  if (!modCase) throw new Error('Case not found');
  if (modCase.status !== 'pending_approval') throw new Error('Case is not pending approval');

  if (modCase.proposerId === approverId) {
    throw new Error('Dual control violation: Approver cannot be the same as proposer');
  }

  // Execute sanction (e.g. suspend material)
  const sanction = modCase.proposedSanction;
  if (sanction === 'suspend_material') {
    await materials.updateOne({ _id: modCase.materialId }, {
      $set: { moderationStatus: 'suspended' }
    });
  }

  await cases.updateOne({ _id: caseId }, {
    $set: {
      status: 'sanctioned',
      approverId,
      approvedAt: new Date()
    }
  });

  // Also close associated reports
  const reports = db.collection('moderation_reports');
  await reports.updateMany(
    { _id: { $in: modCase.reports } },
    { $set: { status: 'closed' } }
  );

  auditLog({ event: 'sanction_approved', caseId, approverId, sanction });
  return { success: true };
}

export async function fileAppeal(caseId, creatorId, reason) {
  const db = await getDb();
  const cases = db.collection('moderation_cases');
  const materials = db.collection('materials');

  const modCase = await cases.findOne({ _id: caseId });
  if (!modCase) throw new Error('Case not found');
  if (modCase.status !== 'sanctioned') throw new Error('Cannot appeal a case that is not sanctioned');

  // Verify creator
  const material = await materials.findOne({ _id: modCase.materialId });
  if (!material || (material.creatorId !== creatorId && material.creatorAddress !== creatorId)) {
    throw new Error('Only the creator can file an appeal');
  }

  // Time-bounded appeal (30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  if (modCase.approvedAt < thirtyDaysAgo) {
    throw new Error('Appeal window has expired');
  }

  await cases.updateOne({ _id: caseId }, {
    $set: {
      status: 'appealed',
      appealReason: reason,
      appealedAt: new Date()
    }
  });

  auditLog({ event: 'appeal_filed', caseId, creatorId });
  return { success: true };
}

export async function resolveAppeal(caseId, decision, reviewerId) {
  const db = await getDb();
  const cases = db.collection('moderation_cases');
  const materials = db.collection('materials');

  const modCase = await cases.findOne({ _id: caseId });
  if (!modCase) throw new Error('Case not found');
  if (modCase.status !== 'appealed') throw new Error('Case is not under appeal');

  if (decision === 'granted') {
    // Reverse sanction
    if (modCase.proposedSanction === 'suspend_material') {
      await materials.updateOne({ _id: modCase.materialId }, {
        $unset: { moderationStatus: "" }
      });
    }
  }

  await cases.updateOne({ _id: caseId }, {
    $set: {
      status: decision === 'granted' ? 'appeal_granted' : 'appeal_denied',
      appealResolvedAt: new Date(),
      appealReviewerId: reviewerId
    }
  });

  auditLog({ event: 'appeal_resolved', caseId, decision, reviewerId });
  return { success: true };
}
