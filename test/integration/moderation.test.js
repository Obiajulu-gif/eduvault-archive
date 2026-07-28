import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
        if (query.materialId) res = res.filter(x => x.materialId === query.materialId);
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
      updateOne: async (query, update) => {
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
        const items = store[name].filter(x => query._id.$in.includes(x._id));
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
});
