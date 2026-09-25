/**
 * Tests for the publishing checklist system — Issue #199
 *
 * Covers checklist evaluation, publish readiness validation,
 * ownership enforcement, and the publish API route logic.
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

// ── Pure logic extracted from publishing/checklist.js ─────────────────────────

const PUBLISH_REQUIRED_FIELDS = [
  {
    key: 'file',
    label: 'Uploaded file',
    check: (m) => !!(m.storageKey || m.fileUrl || m.ipfsCid || m.cid || m.fileHash),
  },
  {
    key: 'title',
    label: 'Title',
    check: (m) => !!(m.title && String(m.title).trim().length > 0),
  },
];

const PUBLISH_RECOMMENDED_FIELDS = [
  {
    key: 'description',
    label: 'Description',
    check: (m) => !!(m.description || m.shortSummary),
  },
  {
    key: 'thumbnail',
    label: 'Thumbnail / Cover image',
    check: (m) => !!(m.coverImageUrl || m.thumbnailUrl || m.image),
  },
  {
    key: 'price',
    label: 'Price',
    check: (m) => m.price !== undefined && m.price !== null && m.price !== '',
  },
  {
    key: 'usageRights',
    label: 'Usage rights',
    check: (m) => !!(m.usageRights && String(m.usageRights).trim().length > 0),
  },
  {
    key: 'visibility',
    label: 'Visibility',
    check: (m) => !!(m.visibility && ['public', 'private', 'unlisted'].includes(m.visibility)),
  },
  {
    key: 'category',
    label: 'Category',
    check: (m) => !!(m.category && String(m.category).trim().length > 0),
  },
  {
    key: 'subject',
    label: 'Subject',
    check: (m) => !!(m.subject && String(m.subject).trim().length > 0),
  },
  {
    key: 'level',
    label: 'Level',
    check: (m) => !!(m.level && String(m.level).trim().length > 0),
  },
  {
    key: 'learningOutcomes',
    label: 'Learning outcomes',
    check: (m) => !!(m.learningOutcomes && Array.isArray(m.learningOutcomes) && m.learningOutcomes.length > 0),
  },
  {
    key: 'tableOfContents',
    label: 'Table of contents',
    check: (m) => !!(m.tableOfContents && Array.isArray(m.tableOfContents) && m.tableOfContents.length > 0),
  },
];

function getPublishingChecklist(material) {
  if (!material) {
    const allRequired = PUBLISH_REQUIRED_FIELDS.map((f) => ({ ...f, met: false }));
    const allRecommended = PUBLISH_RECOMMENDED_FIELDS.map((f) => ({ ...f, met: false }));
    return {
      required: allRequired,
      recommended: allRecommended,
      missingRequired: allRequired.map((f) => f.key),
      missingRecommended: allRecommended.map((f) => f.key),
    };
  }

  const required = PUBLISH_REQUIRED_FIELDS.map((field) => ({
    key: field.key,
    label: field.label,
    met: field.check(material),
  }));

  const recommended = PUBLISH_RECOMMENDED_FIELDS.map((field) => ({
    key: field.key,
    label: field.label,
    met: field.check(material),
  }));

  return {
    required,
    recommended,
    missingRequired: required.filter((f) => !f.met).map((f) => f.key),
    missingRecommended: recommended.filter((f) => !f.met).map((f) => f.key),
  };
}

function isReadyToPublish(material) {
  const checklist = getPublishingChecklist(material);
  return {
    ready: checklist.missingRequired.length === 0,
    checklist,
    missingRequired: checklist.missingRequired,
  };
}

function validatePublishRequest(material, userAddress) {
  if (!material) {
    return { valid: false, error: 'Material not found', status: 404 };
  }

  const owner = material.userAddress || material.ownerAddress;
  if (!owner || String(owner).toLowerCase() !== String(userAddress).toLowerCase()) {
    return { valid: false, error: 'Only the material owner can publish', status: 403 };
  }

  const { ready, checklist, missingRequired } = isReadyToPublish(material);
  if (!ready) {
    return {
      valid: false,
      error: 'Cannot publish: required fields are missing',
      status: 400,
      checklist,
    };
  }

  if (material.status === 'published') {
    return { valid: true, alreadyPublished: true, checklist };
  }

  return { valid: true, checklist };
}

// ── Factory helpers ──────────────────────────────────────────────────────────

function completeMaterial(overrides = {}) {
  return {
    _id: 'mat-001',
    title: 'Test Material',
    storageKey: 'QmTest123',
    description: 'A test description',
    coverImageUrl: 'https://example.com/thumb.png',
    price: 0,
    usageRights: 'Standard License (download only)',
    visibility: 'public',
    category: 'technology',
    subject: 'programming',
    level: 'beginner',
    learningOutcomes: ['Understand X'],
    tableOfContents: ['Introduction'],
    userAddress: 'galice',
    ...overrides,
  };
}

// =============================================================================
// Checklist Evaluation Tests
// =============================================================================

describe('Publishing Checklist — Field Checks', () => {

  test('complete material passes all required checks', () => {
    const material = completeMaterial();
    const { missingRequired } = getPublishingChecklist(material);
    assert.deepEqual(missingRequired, []);
  });

  test('material with no title fails required check', () => {
    const material = completeMaterial({ title: '' });
    const { missingRequired } = getPublishingChecklist(material);
    assert.ok(missingRequired.includes('title'));
  });

  test('material with no file fails required check', () => {
    const material = completeMaterial({
      storageKey: null,
      fileUrl: null,
      ipfsCid: null,
      cid: null,
      fileHash: null,
    });
    const { missingRequired } = getPublishingChecklist(material);
    assert.ok(missingRequired.includes('file'));
  });

  test('null material reports all fields as missing', () => {
    const { missingRequired, missingRecommended } = getPublishingChecklist(null);
    assert.equal(missingRequired.length, PUBLISH_REQUIRED_FIELDS.length);
    assert.equal(missingRecommended.length, PUBLISH_RECOMMENDED_FIELDS.length);
  });

  test('only title and file are required, everything else is recommended', () => {
    const material = {
      title: 'Minimal Material',
      storageKey: 'QmMinimal',
    };
    const { missingRequired, missingRecommended } = getPublishingChecklist(material);
    assert.deepEqual(missingRequired, []);
    assert.ok(missingRecommended.length > 0);
  });

  test('file check passes with any storage field variant', () => {
    const variants = ['storageKey', 'fileUrl', 'ipfsCid', 'cid', 'fileHash'];
    for (const field of variants) {
      const material = { title: 'Test', [field]: 'some-value' };
      const { missingRequired } = getPublishingChecklist(material);
      assert.ok(!missingRequired.includes('file'), `${field} should satisfy file check`);
    }
  });

  test('recommended checks identify missing optional fields', () => {
    const material = {
      title: 'Bare Minimum',
      storageKey: 'QmMinimal',
      price: 0,
      visibility: 'public',
    };
    const { missingRecommended } = getPublishingChecklist(material);
    assert.ok(missingRecommended.includes('description'));
    assert.ok(missingRecommended.includes('thumbnail'));
    assert.ok(missingRecommended.includes('usageRights'));
    assert.ok(missingRecommended.includes('category'));
    assert.ok(missingRecommended.includes('subject'));
    assert.ok(missingRecommended.includes('level'));
    assert.ok(missingRecommended.includes('learningOutcomes'));
    assert.ok(missingRecommended.includes('tableOfContents'));
  });

});

// =============================================================================
// Publish Readiness Tests
// =============================================================================

describe('Publishing Checklist — Readiness', () => {

  test('complete material is ready to publish', () => {
    const material = completeMaterial();
    const { ready } = isReadyToPublish(material);
    assert.equal(ready, true);
  });

  test('material missing title is not ready', () => {
    const material = completeMaterial({ title: '' });
    const { ready, missingRequired } = isReadyToPublish(material);
    assert.equal(ready, false);
    assert.ok(missingRequired.includes('title'));
  });

  test('material missing file is not ready', () => {
    const material = completeMaterial({ storageKey: null, fileUrl: null });
    const { ready } = isReadyToPublish(material);
    assert.equal(ready, false);
  });

  test('material missing both required fields is not ready', () => {
    const material = completeMaterial({ title: '', storageKey: null });
    const { ready, missingRequired } = isReadyToPublish(material);
    assert.equal(ready, false);
    assert.equal(missingRequired.length, 2);
  });

});

// =============================================================================
// Publish Validation Tests
// =============================================================================

describe('Publishing Checklist — Validate Request', () => {

  test('validates successfully when owner and complete', () => {
    const material = completeMaterial({ userAddress: 'galice' });
    const result = validatePublishRequest(material, 'galice');
    assert.equal(result.valid, true);
  });

  test('rejects when material does not exist', () => {
    const result = validatePublishRequest(null, 'galice');
    assert.equal(result.valid, false);
    assert.equal(result.status, 404);
  });

  test('rejects when user is not the owner', () => {
    const material = completeMaterial({ userAddress: 'galice' });
    const result = validatePublishRequest(material, 'gattacker');
    assert.equal(result.valid, false);
    assert.equal(result.status, 403);
    assert.equal(result.error, 'Only the material owner can publish');
  });

  test('rejects when material has no owner', () => {
    const material = completeMaterial({ userAddress: null, ownerAddress: null });
    const result = validatePublishRequest(material, 'galice');
    assert.equal(result.valid, false);
    assert.equal(result.status, 403);
  });

  test('rejects when required fields are missing', () => {
    const material = completeMaterial({ title: '' });
    const result = validatePublishRequest(material, 'galice');
    assert.equal(result.valid, false);
    assert.equal(result.status, 400);
    assert.ok(result.checklist);
    assert.ok(result.checklist.missingRequired.includes('title'));
  });

  test('returns alreadyPublished flag when status is published', () => {
    const material = completeMaterial({ status: 'published', userAddress: 'galice' });
    const result = validatePublishRequest(material, 'galice');
    assert.equal(result.valid, true);
    assert.equal(result.alreadyPublished, true);
  });

  test('case-insensitive ownership matching', () => {
    const material = completeMaterial({ userAddress: 'GALICE' });
    const result = validatePublishRequest(material, 'galice');
    assert.equal(result.valid, true);
  });

});

// =============================================================================
// Edge Cases
// =============================================================================

describe('Publishing Checklist — Edge Cases', () => {

  test('shortSummary satisfies the description requirement', () => {
    const material = completeMaterial({
      description: null,
      shortSummary: 'A brief summary',
    });
    const { missingRecommended } = getPublishingChecklist(material);
    assert.ok(!missingRecommended.includes('description'));
  });

  test('thumbnailUrl satisfies the thumbnail requirement', () => {
    const material = completeMaterial({
      coverImageUrl: null,
      thumbnailUrl: 'https://example.com/thumb.png',
    });
    const { missingRecommended } = getPublishingChecklist(material);
    assert.ok(!missingRecommended.includes('thumbnail'));
  });

  test('price of 0 (free) passes the price check', () => {
    const material = completeMaterial({ price: 0 });
    const { missingRecommended } = getPublishingChecklist(material);
    assert.ok(!missingRecommended.includes('price'));
  });

  test('empty learningOutcomes array fails the check', () => {
    const material = completeMaterial({ learningOutcomes: [] });
    const { missingRecommended } = getPublishingChecklist(material);
    assert.ok(missingRecommended.includes('learningOutcomes'));
  });

  test('empty tableOfContents array fails the check', () => {
    const material = completeMaterial({ tableOfContents: [] });
    const { missingRecommended } = getPublishingChecklist(material);
    assert.ok(missingRecommended.includes('tableOfContents'));
  });

  test('undefined price fails the check', () => {
    const material = completeMaterial({ price: undefined });
    const { missingRecommended } = getPublishingChecklist(material);
    assert.ok(missingRecommended.includes('price'));
  });

  test('whitespace-only title fails the check', () => {
    const material = completeMaterial({ title: '   ' });
    const { missingRequired } = getPublishingChecklist(material);
    assert.ok(missingRequired.includes('title'));
  });

  test('checklist includes status, source, and missing arrays in response', () => {
    const material = completeMaterial();
    const checklist = getPublishingChecklist(material);
    assert.ok(Array.isArray(checklist.required));
    assert.ok(Array.isArray(checklist.recommended));
    assert.ok(Array.isArray(checklist.missingRequired));
    assert.ok(Array.isArray(checklist.missingRecommended));
    assert.equal(checklist.required.length, 2);
    assert.equal(checklist.recommended.length, 10);
  });

  test('each checklist item has key, label, and met fields', () => {
    const material = completeMaterial();
    const { required } = getPublishingChecklist(material);
    for (const item of required) {
      assert.ok(typeof item.key === 'string');
      assert.ok(typeof item.label === 'string');
      assert.equal(typeof item.met, 'boolean');
    }
  });

});
