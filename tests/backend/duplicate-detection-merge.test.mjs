import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeContentFingerprint,
  normalizeText,
  compareMaterials,
  detectDuplicates,
  DUPLICATE_REASONS,
} from '../../src/lib/marketplace/duplicateDetection.js';
import {
  createMergeReview,
  updateReviewDecision,
  executeMerge,
  reverseMerge,
  resolveMergedMaterial,
  REVIEW_STATUS,
} from '../../src/lib/marketplace/mergeReviewWorkflow.js';
import { getMaterialAccessStatus } from '../../src/lib/purchases/access.js';

function createMockDb(initialState = {}) {
  const store = {};
  for (const [colName, docs] of Object.entries(initialState)) {
    store[colName] = new Map(Object.entries(docs));
  }

  return {
    collection(name) {
      if (!store[name]) store[name] = new Map();
      const map = store[name];

      return {
        async findOne(query) {
          for (const doc of map.values()) {
            let match = true;
            if (query.$or) {
              match = query.$or.some((subQuery) => {
                return Object.entries(subQuery).every(([k, v]) => doc[k] === v);
              });
            } else {
              for (const [k, v] of Object.entries(query)) {
                if (k === '$or') continue;
                if (doc[k] !== v) {
                  match = false;
                  break;
                }
              }
            }
            if (match) return JSON.parse(JSON.stringify(doc));
          }
          return null;
        },
        async insertOne(doc) {
          const id = doc.reviewId || doc.materialId || doc._id || `id-${map.size + 1}`;
          const copy = JSON.parse(JSON.stringify(doc));
          copy._id = id;
          map.set(id, copy);
          return { acknowledged: true, insertedId: id };
        },
        async updateOne(query, update) {
          for (const [key, doc] of map.entries()) {
            let match = true;
            if (query.$or) {
              match = query.$or.some((subQuery) => {
                return Object.entries(subQuery).every(([k, v]) => doc[k] === v);
              });
            } else {
              for (const [k, v] of Object.entries(query)) {
                if (doc[k] !== v) {
                  match = false;
                  break;
                }
              }
            }
            if (match) {
              if (update.$set) Object.assign(doc, JSON.parse(JSON.stringify(update.$set)));
              return { matchedCount: 1, modifiedCount: 1 };
            }
          }
          return { matchedCount: 0, modifiedCount: 0 };
        },
        find() {
          return {
            sort() {
              return {
                limit() {
                  return {
                    async toArray() {
                      return Array.from(map.values());
                    },
                  };
                },
              };
            },
            async toArray() {
              return Array.from(map.values());
            },
          };
        },
      };
    },
  };
}

test('deterministic fingerprinting produces identical hashes for same content regardless of formatting', () => {
  const mat1 = {
    title: '  Complete Stellar Rust Course  ',
    description: 'Learn Soroban development step-by-step.',
    tags: ['rust', 'stellar', 'soroban'],
    creator: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVWAC',
    cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  };

  const mat2 = {
    title: 'complete stellar rust course',
    description: 'learn soroban development step by step',
    tags: ['soroban', 'rust', 'stellar'], // different order
    creator: 'ga7qynf7sowq3glr2bgmzehxavirza4kvwltjjfc7mgxua74p7ujvwac', // lowercase
    cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  };

  const fp1 = computeContentFingerprint(mat1);
  const fp2 = computeContentFingerprint(mat2);

  assert.equal(fp1, fp2);
  assert.equal(typeof fp1, 'string');
  assert.equal(fp1.length, 64);
});

test('compareMaterials detects exact IPFS CID match', () => {
  const matA = {
    materialId: 'mat-1',
    title: 'Math Grade 10',
    cid: 'QmZtmD2qt8fJv3CLDHmeDeGMr9887YjEgNNNiY41PDBGWB',
  };
  const matB = {
    materialId: 'mat-2',
    title: 'Grade 10 Mathematics',
    cid: 'QmZtmD2qt8fJv3CLDHmeDeGMr9887YjEgNNNiY41PDBGWB',
  };

  const result = compareMaterials(matA, matB);
  assert.equal(result.isDuplicate, true);
  assert.ok(result.reasons.includes(DUPLICATE_REASONS.IDENTICAL_ASSET_CID));
  assert.ok(result.score >= 0.99);
});

test('compareMaterials detects identical creator and normalized title collision', () => {
  const matA = {
    materialId: 'mat-10',
    title: 'Soroban 101 - Smart Contracts',
    creator: 'GCREATOR123',
    description: 'Introduction to smart contracts on Stellar',
  };
  const matB = {
    materialId: 'mat-11',
    title: 'soroban 101: smart contracts!',
    creator: 'GCREATOR123',
    description: 'A beginner overview for Soroban devs',
  };

  const result = compareMaterials(matA, matB);
  assert.equal(result.isDuplicate, true);
  assert.ok(result.reasons.includes(DUPLICATE_REASONS.IDENTICAL_CREATOR_AND_TITLE));
  assert.ok(result.score >= 0.90);
});

test('compareMaterials rejects dissimilar materials', () => {
  const matA = {
    materialId: 'mat-20',
    title: 'Biology Fundamentals',
    description: 'Cells and genetics in modern biology',
    creator: 'GBIO1',
  };
  const matB = {
    materialId: 'mat-21',
    title: 'Macroeconomics 201',
    description: 'Fiscal policy and central banking theories',
    creator: 'GECON2',
  };

  const result = compareMaterials(matA, matB);
  assert.equal(result.isDuplicate, false);
  assert.ok(result.score < 0.3);
});

test('detectDuplicates sorts older material as canonical and newer as duplicate', () => {
  const materials = [
    {
      materialId: 'mat-newer',
      title: 'Python for Data Analysis',
      cid: 'cid-python-data',
      createdAt: '2026-02-01T00:00:00Z',
    },
    {
      materialId: 'mat-older',
      title: 'Python for Data Analysis',
      cid: 'cid-python-data',
      createdAt: '2026-01-01T00:00:00Z',
    },
  ];

  const candidates = detectDuplicates(materials);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].canonicalId, 'mat-older');
  assert.equal(candidates[0].duplicateId, 'mat-newer');
});

test('full merge review workflow: review creation, approval, execution, aliased access, and reversal', async () => {
  const db = createMockDb({
    materials: {
      'mat-canon': {
        materialId: 'mat-canon',
        title: 'Algorithms in Go',
        status: 'published',
        price: 15,
        aliases: [],
      },
      'mat-dupe': {
        materialId: 'mat-dupe',
        title: 'Algorithms in Go (Copy)',
        status: 'published',
        price: 15,
      },
    },
    purchases: {
      'purchase-1': {
        materialId: 'mat-dupe',
        buyerAddress: 'gbuyer999',
        status: 'settled',
      },
    },
    duplicate_merge_reviews: {},
  });

  // 1. Create review
  const candidate = {
    canonicalId: 'mat-canon',
    duplicateId: 'mat-dupe',
    score: 0.98,
    reasons: [DUPLICATE_REASONS.HIGH_SIMILARITY_METADATA],
  };
  const review = await createMergeReview(db, candidate, 'system-detector');
  assert.equal(review.status, REVIEW_STATUS.DETECTED);
  assert.equal(review.reviewId, 'rev-mat-canon-mat-dupe');

  // 2. Reviewer approves
  const approvedReview = await updateReviewDecision(
    db,
    review.reviewId,
    REVIEW_STATUS.APPROVED,
    'moderator-alice',
    'Confirmed duplicate content from same lecture series'
  );
  assert.equal(approvedReview.status, REVIEW_STATUS.APPROVED);
  assert.equal(approvedReview.reviewedBy, 'moderator-alice');

  // 3. Execute Merge
  const mergeResult = await executeMerge(db, review.reviewId, 'operator-bob');
  assert.equal(mergeResult.success, true);

  const matDupe = await db.collection('materials').findOne({ materialId: 'mat-dupe' });
  assert.equal(matDupe.status, 'merged');
  assert.equal(matDupe.mergedInto, 'mat-canon');

  const matCanon = await db.collection('materials').findOne({ materialId: 'mat-canon' });
  assert.ok(matCanon.aliases.includes('mat-dupe'));

  // 4. Verify buyer holding purchase on mat-dupe gets access to mat-canon transparently
  const accessCheckOnDupe = await getMaterialAccessStatus(db, 'mat-dupe', 'GBUYER999');
  assert.equal(accessCheckOnDupe.status, 'active');
  assert.equal(accessCheckOnDupe.hasAccess, true);

  const accessCheckOnCanon = await getMaterialAccessStatus(db, 'mat-canon', 'GBUYER999');
  assert.equal(accessCheckOnCanon.status, 'active');
  assert.equal(accessCheckOnCanon.hasAccess, true);

  // 5. Test resolution helper
  const resolved = await resolveMergedMaterial(db, 'mat-dupe');
  assert.equal(resolved.isMerged, true);
  assert.equal(resolved.canonicalId, 'mat-canon');

  // 6. Test Reverse Merge (rollback)
  const reversalResult = await reverseMerge(
    db,
    review.reviewId,
    'operator-bob',
    'False positive reported by author with distinct version history'
  );
  assert.equal(reversalResult.success, true);
  assert.equal(reversalResult.status, REVIEW_STATUS.REVERSED);

  const restoredDupe = await db.collection('materials').findOne({ materialId: 'mat-dupe' });
  assert.equal(restoredDupe.status, 'published');
  assert.equal(restoredDupe.mergedInto, null);

  const restoredCanon = await db.collection('materials').findOne({ materialId: 'mat-canon' });
  assert.equal(restoredCanon.aliases.includes('mat-dupe'), false);
});
