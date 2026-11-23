import { describe, it, expect } from 'vitest';
import {
  valuesAreEqual,
  diffDocuments,
  validateFieldAuthorization,
  resolveConflictThreeWay,
  buildConflictAuditRecord,
  CONFLICT_STATUS,
} from '../conflictResolver.js';

describe('conflictResolver Vitest unit tests', () => {
  describe('valuesAreEqual', () => {
    it('compares primitives correctly', () => {
      expect(valuesAreEqual(42, 42)).toBe(true);
      expect(valuesAreEqual('abc', 'abc')).toBe(true);
      expect(valuesAreEqual(true, false)).toBe(false);
      expect(valuesAreEqual(null, undefined)).toBe(false);
      expect(valuesAreEqual(null, null)).toBe(true);
    });

    it('compares dates by timestamp value', () => {
      const d1 = new Date('2026-01-01T00:00:00Z');
      const d2 = new Date('2026-01-01T00:00:00Z');
      const d3 = new Date('2026-01-02T00:00:00Z');
      expect(valuesAreEqual(d1, d2)).toBe(true);
      expect(valuesAreEqual(d1, d3)).toBe(false);
    });

    it('compares arrays and nested objects deeply', () => {
      expect(valuesAreEqual([1, 2, [3, 4]], [1, 2, [3, 4]])).toBe(true);
      expect(valuesAreEqual([1, 2], [1, 3])).toBe(false);
      expect(valuesAreEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toBe(true);
      expect(valuesAreEqual({ a: 1 }, { a: 2 })).toBe(false);
    });
  });

  describe('diffDocuments', () => {
    it('identifies added, modified, and deleted fields', () => {
      const base = { title: 'Old', price: 10, obsolete: true };
      const target = { title: 'New', price: 10, newField: 'added' };

      const diff = diffDocuments(base, target);

      expect(diff.modified).toHaveProperty('title');
      expect(diff.modified.title).toEqual({ from: 'Old', to: 'New' });
      expect(diff.added).toHaveProperty('newField', 'added');
      expect(diff.deleted).toContain('obsolete');
      expect(diff.modified).not.toHaveProperty('price');
    });

    it('ignores immutable system fields', () => {
      const base = { _id: '1', version: 1, title: 'Test' };
      const target = { _id: '1', version: 2, title: 'Test 2' };

      const diff = diffDocuments(base, target);
      expect(diff.modified).not.toHaveProperty('_id');
      expect(diff.modified).not.toHaveProperty('version');
    });
  });

  describe('validateFieldAuthorization', () => {
    it('denies learner role', () => {
      const res = validateFieldAuthorization({
        actor: { role: 'learner' },
        fieldsToUpdate: ['title'],
      });
      expect(res.authorized).toBe(false);
      expect(res.error).toContain('Learner role is not authorized');
    });

    it('denies creator editing another creator’s resource', () => {
      const res = validateFieldAuthorization({
        actor: { id: 'creator-1', role: 'creator' },
        resourceOwnerId: 'creator-2',
        fieldsToUpdate: ['title'],
      });
      expect(res.authorized).toBe(false);
      expect(res.error).toContain('owned by another creator');
    });

    it('denies creator editing privileged admin fields', () => {
      const res = validateFieldAuthorization({
        actor: { id: 'creator-1', role: 'creator' },
        resourceOwnerId: 'creator-1',
        fieldsToUpdate: ['title', 'moderationStatus'],
      });
      expect(res.authorized).toBe(false);
      expect(res.error).toContain('cannot modify privileged fields');
      expect(res.unauthorizedFields).toContain('moderationStatus');
    });

    it('allows admin role for any fields', () => {
      const res = validateFieldAuthorization({
        actor: { id: 'admin-1', role: 'admin' },
        resourceOwnerId: 'creator-1',
        fieldsToUpdate: ['moderationStatus', 'quarantineStatus', 'price'],
      });
      expect(res.authorized).toBe(true);
    });
  });

  describe('resolveConflictThreeWay', () => {
    it('returns CLEAN_WRITE when only client modified fields', () => {
      const base = { title: 'Base', version: 1 };
      const server = { title: 'Base', version: 1 };
      const client = { title: 'Client Updated', version: 1 };

      const res = resolveConflictThreeWay({ base, server, client });
      expect(res.status).toBe(CONFLICT_STATUS.CLEAN_WRITE);
      expect(res.canAutoMerge).toBe(true);
      expect(res.mergedDocument.title).toBe('Client Updated');
      expect(res.newVersion).toBe(2);
    });

    it('returns AUTO_MERGED when both diverged orthogonally', () => {
      const base = { title: 'Base', price: 10, version: 1 };
      const server = { title: 'Base', price: 15, version: 2 };
      const client = { title: 'Client Updated', price: 10, version: 1 };

      const res = resolveConflictThreeWay({ base, server, client });
      expect(res.status).toBe(CONFLICT_STATUS.AUTO_MERGED);
      expect(res.canAutoMerge).toBe(true);
      expect(res.mergedDocument.title).toBe('Client Updated');
      expect(res.mergedDocument.price).toBe(15);
      expect(res.newVersion).toBe(3);
    });

    it('enforces deletion tombstone invariant', () => {
      const base = { title: 'Base', isDeleted: false, version: 1 };
      const server = { title: 'Base', isDeleted: true, version: 2 };
      const client = { title: 'Client Revive', isDeleted: false, version: 1 };

      const res = resolveConflictThreeWay({ base, server, client });
      expect(res.canAutoMerge).toBe(false);
      expect(res.status).toBe(CONFLICT_STATUS.INVALID_TRANSITION);
    });
  });

  describe('buildConflictAuditRecord', () => {
    it('creates accurate audit record', () => {
      const record = buildConflictAuditRecord({
        materialId: 'mat-500',
        actor: 'creator-1',
        baseVersion: 2,
        serverVersion: 3,
        newVersion: 4,
        status: CONFLICT_STATUS.AUTO_MERGED,
      });

      expect(record.materialId).toBe('mat-500');
      expect(record.actor).toBe('creator-1');
      expect(record.baseVersion).toBe(2);
      expect(record.serverVersion).toBe(3);
      expect(record.newVersion).toBe(4);
      expect(record.status).toBe(CONFLICT_STATUS.AUTO_MERGED);
    });
  });
});
