import crypto from 'crypto';
import { getDb } from '@/lib/mongodb';
import { auditLog } from '@/lib/api/audit';
import { slidingWindowRateLimit } from '@/lib/api/rateLimit';

export const MODERATION_POLICY_VERSION = 'v1.0';

export async function createReport(data) {
  const db = await getDb();
  const reports = db.collection('moderation_reports');
  const cases = db.collection('moderation_cases');

  const { materialId, reporterId, reason, evidence } = data;

  // Per-reporter rate limiting
  const rateLimit = Number(process.env.REPORT_RATE_LIMIT || 10);
  const windowMs = Number(process.env.REPORT_RATE_WINDOW_MS || 3600000);
  const limitRes = await slidingWindowRateLimit(`report-creation:${reporterId}`, { limit: rateLimit, windowMs });
  if (!limitRes.allowed) {
    return { success: false, message: 'Rate limit exceeded for report creation. Please try again later.' };
  }

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

  // Flag heuristics
  let priorityReview = false;
  let priorityReviewReason = null;

  // 1. Creator-targeted targeted harassment case cluster flagging heuristic
  const material = await db.collection('materials').findOne({ _id: materialId });
  const creatorId = material?.creatorId || material?.creatorAddress || material?.creator;
  if (creatorId) {
    const oneHourAgo = new Date(Date.now() - 3600000);
    const recentReports = await reports.find({
      reporterId,
      createdAt: { $gte: oneHourAgo }
    }).toArray();

    const recentMaterialIds = [...new Set(recentReports.map(r => r.materialId))];
    if (!recentMaterialIds.includes(materialId)) {
      recentMaterialIds.push(materialId);
    }

    const recentMaterials = await db.collection('materials').find({
      _id: { $in: recentMaterialIds }
    }).toArray();

    const creatorMaterials = recentMaterials.filter(m =>
      m.creatorId === creatorId || m.creatorAddress === creatorId || m.creator === creatorId
    );

    const threshold = Number(process.env.REPORT_CREATOR_SPAM_THRESHOLD || 3);
    if (creatorMaterials.length >= threshold) {
      priorityReview = true;
      priorityReviewReason = 'Potential creator harassment (multiple materials reported in short window)';

      // Update other active cases in the cluster
      const matIds = creatorMaterials.map(m => m._id);
      await cases.updateMany(
        { materialId: { $in: matIds }, status: { $ne: 'closed' } },
        { $set: { flaggedForPriorityReview: true, priorityReviewReason } }
      );
    }
  }

  // 2. Evidence-hash spam check
  if (evidenceHash && !priorityReview) {
    const oneHourAgo = new Date(Date.now() - 3600000);
    const existingWithSameEvidence = await reports.findOne({
      evidenceHash,
      materialId: { $ne: materialId },
      createdAt: { $gte: oneHourAgo }
    });
    if (existingWithSameEvidence) {
      priorityReview = true;
      priorityReviewReason = 'Identical evidence submitted across different materials';
    }
  }

  // Check if a case already exists for this material
  let activeCase = await cases.findOne({ materialId, status: { $ne: 'closed' } });

  if (!activeCase) {
    const caseId = crypto.randomUUID();
    const caseDoc = {
      _id: caseId,
      materialId,
      status: 'open',
      reports: [reportId],
      createdAt: timestamp,
      policyVersion: MODERATION_POLICY_VERSION
    };
    if (priorityReview) {
      caseDoc.flaggedForPriorityReview = true;
      caseDoc.priorityReviewReason = priorityReviewReason;
    }
    await cases.insertOne(caseDoc);
    auditLog({ event: 'case_created', materialId, caseId, timestamp });
  } else {
    const updateDoc = { $push: { reports: reportId } };
    if (priorityReview) {
      updateDoc.$set = {
        flaggedForPriorityReview: true,
        priorityReviewReason
      };
    }
    await cases.updateOne({ _id: activeCase._id }, updateDoc);
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

  if (sanction !== 'suspend_material') {
    throw new Error('Unsupported sanction type');
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

  const sanction = modCase.proposedSanction;
  if (sanction !== 'suspend_material') {
    throw new Error('Unsupported sanction type');
  }

  // Execute sanction (e.g. suspend material)
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
