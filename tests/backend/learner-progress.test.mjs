import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setLearnerProgress,
  getLearnerProgress,
  handleMaterialVersionUpdate,
  handleMaterialRollback,
  exportLearnerProgress,
} from '../../src/lib/progress/learnerProgress.js';

function createMockDb() {
  const store = new Map();
  return {
    collection(name) {
      if (!store.has(name)) store.set(name, []);
      const items = store.get(name);
      return {
        async findOne(query) {
          return items.find(item => {
            for (const key of Object.keys(query)) {
              if (item[key] !== query[key]) return false;
            }
            return true;
          }) || null;
        },
        find(query) {
          const matched = items.filter(item => {
            for (const key of Object.keys(query)) {
              if (item[key] !== query[key]) return false;
            }
            return true;
          });
          return {
            async toArray() {
              return matched;
            },
          };
        },
        async findOneAndUpdate(query, update, options) {
          let item = await this.findOne(query);
          if (!item && options?.upsert) {
            item = { ...query };
            if (update.$setOnInsert) Object.assign(item, update.$setOnInsert);
            items.push(item);
          }
          if (!item) return null;
          if (update.$set) Object.assign(item, update.$set);
          return item;
        },
      };
    },
  };
}

describe('Learner Progress Bookmarks & Version Scoping (#708)', () => {
  let db;

  beforeEach(() => {
    db = createMockDb();
  });

  it('attaches bookmarks and progress strictly to purchased material version', async () => {
    const wallet = 'GLEARNER12345678901234567890123456789012';
    const materialId = 'course_math_101';
    const version = '1.0.0';

    const saveRes = await setLearnerProgress({
      db,
      walletAddress: wallet,
      materialId,
      version,
      purchaseId: 'purch_001',
      bookmarks: [{ id: 'bm1', chapter: 1, offset: 45 }],
      completionPercentage: 35,
    });

    assert.equal(saveRes.success, true);

    const getRes = await getLearnerProgress({
      db,
      walletAddress: wallet,
      materialId,
      version,
      requestingActor: wallet,
    });

    assert.equal(getRes.success, true);
    assert.equal(getRes.found, true);
    assert.equal(getRes.progress.version, '1.0.0');
    assert.equal(getRes.progress.completionPercentage, 35);
    assert.equal(getRes.progress.bookmarks.length, 1);
  });

  it('ensures material version updates do not overwrite old version bookmarks', async () => {
    const wallet = 'GLEARNER12345678901234567890123456789012';
    const materialId = 'course_math_101';

    // 1. Create v1 progress
    await setLearnerProgress({
      db,
      walletAddress: wallet,
      materialId,
      version: '1.0.0',
      bookmarks: [{ id: 'bm_v1_chapter1', title: 'v1 Intro' }],
      completionPercentage: 50,
    });

    // 2. Material is updated to v2
    await handleMaterialVersionUpdate({
      db,
      walletAddress: wallet,
      materialId,
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
    });

    // 3. Learner adds new bookmarks on v2
    await setLearnerProgress({
      db,
      walletAddress: wallet,
      materialId,
      version: '2.0.0',
      bookmarks: [
        { id: 'bm_v1_chapter1', title: 'v1 Intro' },
        { id: 'bm_v2_chapter3', title: 'v2 New Chapter' },
      ],
      completionPercentage: 80,
    });

    // 4. Verify v1 progress remains completely untouched and isolated
    const v1Res = await getLearnerProgress({
      db,
      walletAddress: wallet,
      materialId,
      version: '1.0.0',
      requestingActor: wallet,
    });

    assert.equal(v1Res.progress.completionPercentage, 50);
    assert.equal(v1Res.progress.bookmarks.length, 1);
    assert.equal(v1Res.progress.bookmarks[0].id, 'bm_v1_chapter1');

    // Verify v2 has updated bookmarks
    const v2Res = await getLearnerProgress({
      db,
      walletAddress: wallet,
      materialId,
      version: '2.0.0',
      requestingActor: wallet,
    });
    assert.equal(v2Res.progress.completionPercentage, 80);
    assert.equal(v2Res.progress.bookmarks.length, 2);
  });

  it('handles material rollback preserving historical version bookmarks', async () => {
    const wallet = 'GLEARNER12345678901234567890123456789012';
    const materialId = 'course_physics';

    // Set v1.0.0 progress
    await setLearnerProgress({
      db,
      walletAddress: wallet,
      materialId,
      version: '1.0.0',
      bookmarks: [{ id: 'bm_p1', label: 'Quantum mechanics intro' }],
      completionPercentage: 100,
    });

    // Rollback request to v1.0.0
    const rollbackRes = await handleMaterialRollback({
      db,
      walletAddress: wallet,
      materialId,
      targetVersion: '1.0.0',
      requestingActor: wallet,
    });

    assert.equal(rollbackRes.success, true);
    assert.equal(rollbackRes.found, true);
    assert.equal(rollbackRes.progress.completionPercentage, 100);
    assert.equal(rollbackRes.progress.bookmarks[0].id, 'bm_p1');
  });

  it('enforces privacy rules for progress reads and learner data export', async () => {
    const wallet = 'GLEARNER12345678901234567890123456789012';
    const anotherUser = 'GOTHERUSER99999999999999999999999999999';

    await setLearnerProgress({
      db,
      walletAddress: wallet,
      materialId: 'course_secret',
      version: '1.0.0',
      bookmarks: [{ id: 'private_bm' }],
    });

    // Other user trying to read learner progress is blocked
    const readRes = await getLearnerProgress({
      db,
      walletAddress: wallet,
      materialId: 'course_secret',
      version: '1.0.0',
      requestingActor: anotherUser,
    });

    assert.equal(readRes.success, false);
    assert.equal(readRes.reason, 'unauthorized_privacy_violation');

    // Other user trying to export learner data is blocked
    const exportRes = await exportLearnerProgress({
      db,
      walletAddress: wallet,
      requestingActor: anotherUser,
    });

    assert.equal(exportRes.success, false);
    assert.equal(exportRes.reason, 'unauthorized_privacy_violation');

    // Owner can export successfully
    const ownerExport = await exportLearnerProgress({
      db,
      walletAddress: wallet,
      requestingActor: wallet,
    });

    assert.equal(ownerExport.success, true);
    assert.equal(ownerExport.export.totalRecords, 1);
    assert.equal(ownerExport.export.records[0].materialId, 'course_secret');
  });
});
