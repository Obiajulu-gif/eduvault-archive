import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const auditLogMock = vi.fn();
vi.mock('@/lib/api/audit', () => ({
  auditLog: (args) => auditLogMock(args)
}));

// Mock getDb before anything else
vi.mock('@/lib/mongodb', () => {
  const store = {
    moderation_cases: [],
    moderation_reports: [],
    materials: []
  };

  const createCollectionMock = (name) => {
    return {
      find: (query) => {
        let res = store[name];
        if (query) {
          res = res.filter(x => {
            for (const key in query) {
              if (typeof query[key] === 'object' && query[key].$in) {
                if (!query[key].$in.includes(x[key])) return false;
              } else if (typeof query[key] === 'object' && query[key].$ne) {
                if (x[key] === query[key].$ne) return false;
              } else if (typeof query[key] === 'object' && query[key].$gte) {
                if (x[key] < query[key].$gte) return false;
              } else {
                if (x[key] !== query[key]) return false;
              }
            }
            return true;
          });
        }
        return {
          toArray: async () => res
        };
      },
      findOne: async (query) => {
        return store[name].find(x => {
          for (const key in query) {
            if (typeof query[key] === 'object' && query[key].$ne) {
               if (x[key] === query[key].$ne) return false;
            } else if (typeof query[key] === 'object' && query[key].$in) {
               if (!query[key].$in.includes(x[key])) return false;
            } else if (typeof query[key] === 'object' && query[key].$gte) {
               if (x[key] < query[key].$gte) return false;
            } else {
               if (x[key] !== query[key]) return false;
            }
          }
          return true;
        }) || null;
      },
      insertOne: async (doc) => {
        store[name].push(doc);
        return { insertedId: doc._id };
      },
      updateOne: async (query, update, options = {}) => {
        const item = await createCollectionMock(name).findOne(query);
        if (item) {
          if (update.$set) Object.assign(item, update.$set);
          if (update.$unset) {
            for (const key in update.$unset) delete item[key];
          }
          if (update.$push) {
            for (const key in update.$push) {
              item[key] = item[key] || [];
              item[key].push(update.$push[key]);
            }
          }
        }
      },
      updateMany: async (query, update) => {
        const items = store[name].filter(x => {
          if (query.materialId && query.materialId.$in) {
            return query.materialId.$in.includes(x.materialId);
          }
          if (query._id && query._id.$in) {
            return query._id.$in.includes(x._id);
          }
          return false;
        });
        for (const item of items) {
          if (update.$set) Object.assign(item, update.$set);
        }
      },
      deleteMany: async () => {
        store[name] = [];
      }
    };
  };

  return {
    getDb: async () => ({
      collection: (name) => createCollectionMock(name)
    })
  };
});

import { getDb } from '@/lib/mongodb';
import { createReport, proposeSanction, approveSanction, fileAppeal, resolveAppeal } from '@/lib/moderation/cases';
import crypto from 'crypto';

let db;

beforeEach(async () => {
  db = await getDb();
  await db.collection('moderation_cases').deleteMany({});
  await db.collection('moderation_reports').deleteMany({});
  await db.collection('materials').deleteMany({});
});

describe('Moderation System', () => {
  it('should deduplicate active reports for the same material by the same reporter', async () => {
    const materialId = 'mat_123';
    await db.collection('materials').insertOne({ _id: materialId, creatorId: 'user_1' });

    // First report
    const res1 = await createReport({
      materialId,
      reporterId: 'reporter_1',
      reason: 'Inappropriate content',
      evidence: { details: 'bad stuff' }
    });
    
    expect(res1.success).toBe(true);

    // Duplicate report
    const res2 = await createReport({
      materialId,
      reporterId: 'reporter_1',
      reason: 'Still inappropriate',
      evidence: { details: 'very bad' }
    });

    expect(res2.success).toBe(false);
    expect(res2.message).toContain('Active report already exists');

    // Report from different user should succeed and link to same case
    const res3 = await createReport({
      materialId,
      reporterId: 'reporter_2',
      reason: 'Agree it is bad'
    });

    expect(res3.success).toBe(true);

    const cases = await db.collection('moderation_cases').find({ materialId }).toArray();
    expect(cases.length).toBe(1);
    expect(cases[0].reports.length).toBe(2);
  });

  it('should enforce dual control: approver cannot be proposer', async () => {
    const materialId = 'mat_dual_1';
    await db.collection('materials').insertOne({ _id: materialId, creatorId: 'user_1' });

    const reportRes = await createReport({ materialId, reporterId: 'rep_1', reason: 'spam' });
    const caseObj = await db.collection('moderation_cases').findOne({ materialId });

    // Propose sanction
    await proposeSanction(caseObj._id, 'suspend_material', 'admin_1');
    
    // Admin 1 cannot approve their own proposal
    await expect(approveSanction(caseObj._id, 'admin_1')).rejects.toThrow('Dual control violation');

    // Admin 2 can approve
    await approveSanction(caseObj._id, 'admin_2');

    const updatedCase = await db.collection('moderation_cases').findOne({ _id: caseObj._id });
    expect(updatedCase.status).toBe('sanctioned');
    
    // Check side-effect
    const updatedMaterial = await db.collection('materials').findOne({ _id: materialId });
    expect(updatedMaterial.moderationStatus).toBe('suspended');
  });

  it('should prevent reviewer from moderating their own material', async () => {
    const materialId = 'mat_conflict';
    const creatorId = 'admin_corrupt';
    await db.collection('materials').insertOne({ _id: materialId, creatorId });

    await createReport({ materialId, reporterId: 'rep_1', reason: 'spam' });
    const caseObj = await db.collection('moderation_cases').findOne({ materialId });

    await expect(proposeSanction(caseObj._id, 'suspend_material', creatorId)).rejects.toThrow('Conflict of interest');
  });

  it('should safely reverse side-effects upon granted appeal', async () => {
    const materialId = 'mat_appeal';
    await db.collection('materials').insertOne({ _id: materialId, creatorId: 'creator_abc' });

    await createReport({ materialId, reporterId: 'rep_1', reason: 'spam' });
    const caseObj = await db.collection('moderation_cases').findOne({ materialId });

    await proposeSanction(caseObj._id, 'suspend_material', 'admin_1');
    await approveSanction(caseObj._id, 'admin_2');

    // Material is suspended
    let mat = await db.collection('materials').findOne({ _id: materialId });
    expect(mat.moderationStatus).toBe('suspended');

    // File appeal
    await fileAppeal(caseObj._id, 'creator_abc', 'I fixed it');
    
    // Resolve appeal and grant
    await resolveAppeal(caseObj._id, 'granted', 'admin_3');

    // Material should no longer be suspended
    mat = await db.collection('materials').findOne({ _id: materialId });
    expect(mat.moderationStatus).toBeUndefined();

    const finalCase = await db.collection('moderation_cases').findOne({ _id: caseObj._id });
    expect(finalCase.status).toBe('appeal_granted');
  });

  it('should reject filing appeal outside the 30-day window', async () => {
    const materialId = 'mat_window';
    await db.collection('materials').insertOne({ _id: materialId, creatorId: 'creator_abc' });
    await createReport({ materialId, reporterId: 'rep_1', reason: 'spam' });
    const caseObj = await db.collection('moderation_cases').findOne({ materialId });

    await proposeSanction(caseObj._id, 'suspend_material', 'admin_1');
    await approveSanction(caseObj._id, 'admin_2');

    // Manually set approvedAt to 31 days ago in the database
    const modCase = await db.collection('moderation_cases').findOne({ _id: caseObj._id });
    modCase.approvedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);

    await expect(fileAppeal(caseObj._id, 'creator_abc', 'I appeal')).rejects.toThrow('Appeal window has expired');
  });

  it('should reject appeal filed by non-creator', async () => {
    const materialId = 'mat_non_creator';
    await db.collection('materials').insertOne({ _id: materialId, creatorId: 'creator_abc' });
    await createReport({ materialId, reporterId: 'rep_1', reason: 'spam' });
    const caseObj = await db.collection('moderation_cases').findOne({ materialId });

    await proposeSanction(caseObj._id, 'suspend_material', 'admin_1');
    await approveSanction(caseObj._id, 'admin_2');

    await expect(fileAppeal(caseObj._id, 'evil_hacker', 'I appeal')).rejects.toThrow('Only the creator can file an appeal');
  });

  it('should stamp and preserve MODERATION_POLICY_VERSION', async () => {
    const materialId = 'mat_policy';
    await db.collection('materials').insertOne({ _id: materialId, creatorId: 'creator_abc' });

    const reportRes = await createReport({ materialId, reporterId: 'rep_1', reason: 'spam' });
    const report = await db.collection('moderation_reports').findOne({ _id: reportRes.reportId });
    expect(report.policyVersion).toBe('v1.0');

    const caseObj = await db.collection('moderation_cases').findOne({ materialId });
    expect(caseObj.policyVersion).toBe('v1.0');
  });

  it('should verify audit log events fire correctly at all transitions', async () => {
    const materialId = 'mat_audit';
    await db.collection('materials').insertOne({ _id: materialId, creatorId: 'creator_abc' });

    // 1. case_created
    const reportRes = await createReport({ materialId, reporterId: 'rep_1', reason: 'spam' });
    expect(auditLogMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'case_created' }));
    auditLogMock.mockClear();

    const caseObj = await db.collection('moderation_cases').findOne({ materialId });

    // 2. sanction_proposed
    await proposeSanction(caseObj._id, 'suspend_material', 'admin_1');
    expect(auditLogMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'sanction_proposed' }));
    auditLogMock.mockClear();

    // 3. sanction_approved
    await approveSanction(caseObj._id, 'admin_2');
    expect(auditLogMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'sanction_approved' }));
    auditLogMock.mockClear();

    // 4. appeal_filed
    await fileAppeal(caseObj._id, 'creator_abc', 'appeal');
    expect(auditLogMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'appeal_filed' }));
    auditLogMock.mockClear();

    // 5. appeal_resolved
    await resolveAppeal(caseObj._id, 'granted', 'admin_3');
    expect(auditLogMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'appeal_resolved' }));
  });

  it('should verify approveSanction and proposeSanction reject unrecognized sanction type', async () => {
    const materialId = 'mat_invalid_sanction';
    await db.collection('materials').insertOne({ _id: materialId, creatorId: 'creator_abc' });
    await createReport({ materialId, reporterId: 'rep_1', reason: 'spam' });
    const caseObj = await db.collection('moderation_cases').findOne({ materialId });

    // Propose invalid sanction
    await expect(proposeSanction(caseObj._id, 'invalid_sanction_type', 'admin_1')).rejects.toThrow('Unsupported sanction type');

    // Approve invalid sanction (manually inject invalid sanction)
    await proposeSanction(caseObj._id, 'suspend_material', 'admin_1');
    await db.collection('moderation_cases').updateOne({ _id: caseObj._id }, { $set: { proposedSanction: 'invalid_sanction_type' } });
    await expect(approveSanction(caseObj._id, 'admin_2')).rejects.toThrow('Unsupported sanction type');
  });

  it('should enforce report rate limiting', async () => {
    process.env.REPORT_RATE_LIMIT = '2';
    process.env.REPORT_RATE_WINDOW_MS = '60000';

    const materialId = 'mat_rate';
    await db.collection('materials').insertOne({ _id: materialId, creatorId: 'creator_abc' });

    const res1 = await createReport({ materialId, reporterId: 'spammer', reason: 'spam' });
    expect(res1.success).toBe(true);

    const materialId2 = 'mat_rate_2';
    await db.collection('materials').insertOne({ _id: materialId2, creatorId: 'creator_abc' });
    const res2 = await createReport({ materialId: materialId2, reporterId: 'spammer', reason: 'spam' });
    expect(res2.success).toBe(true);

    const materialId3 = 'mat_rate_3';
    await db.collection('materials').insertOne({ _id: materialId3, creatorId: 'creator_abc' });
    const res3 = await createReport({ materialId: materialId3, reporterId: 'spammer', reason: 'spam' });
    expect(res3.success).toBe(false);
    expect(res3.message).toContain('Rate limit exceeded');

    delete process.env.REPORT_RATE_LIMIT;
    delete process.env.REPORT_RATE_WINDOW_MS;
  });

  it('should flag case cluster for priority review when creator-targeted harassment is detected', async () => {
    process.env.REPORT_CREATOR_SPAM_THRESHOLD = '3';

    const creatorId = 'creator_harassed';
    const mat1 = 'mat_h1';
    const mat2 = 'mat_h2';
    const mat3 = 'mat_h3';

    await db.collection('materials').insertOne({ _id: mat1, creatorId });
    await db.collection('materials').insertOne({ _id: mat2, creatorId });
    await db.collection('materials').insertOne({ _id: mat3, creatorId });

    await createReport({ materialId: mat1, reporterId: 'harasser', reason: 'spam' });
    await createReport({ materialId: mat2, reporterId: 'harasser', reason: 'spam' });
    
    let case1 = await db.collection('moderation_cases').findOne({ materialId: mat1 });
    expect(case1.flaggedForPriorityReview).toBeUndefined();

    await createReport({ materialId: mat3, reporterId: 'harasser', reason: 'spam' });

    case1 = await db.collection('moderation_cases').findOne({ materialId: mat1 });
    const case2 = await db.collection('moderation_cases').findOne({ materialId: mat2 });
    const case3 = await db.collection('moderation_cases').findOne({ materialId: mat3 });

    expect(case1.flaggedForPriorityReview).toBe(true);
    expect(case1.priorityReviewReason).toContain('Potential creator harassment');
    expect(case2.flaggedForPriorityReview).toBe(true);
    expect(case3.flaggedForPriorityReview).toBe(true);

    delete process.env.REPORT_CREATOR_SPAM_THRESHOLD;
  });

  it('should flag case for priority review when identical evidence hash is submitted', async () => {
    const mat1 = 'mat_ev1';
    const mat2 = 'mat_ev2';

    await db.collection('materials').insertOne({ _id: mat1, creatorId: 'creator1' });
    await db.collection('materials').insertOne({ _id: mat2, creatorId: 'creator2' });

    const sharedEvidence = { url: 'http://spam.evidence', comment: 'identical text' };

    await createReport({ materialId: mat1, reporterId: 'user1', reason: 'spam', evidence: sharedEvidence });
    await createReport({ materialId: mat2, reporterId: 'user2', reason: 'spam', evidence: sharedEvidence });

    const case2 = await db.collection('moderation_cases').findOne({ materialId: mat2 });
    expect(case2.flaggedForPriorityReview).toBe(true);
    expect(case2.priorityReviewReason).toContain('Identical evidence submitted');
  });
});
