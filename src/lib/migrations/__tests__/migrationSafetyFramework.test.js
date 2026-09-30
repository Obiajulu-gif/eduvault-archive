/**
 * Tests for Migration Safety Framework
 * Issue #809
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SafeMigration,
  AddNotificationPreferencesMigration,
} from '../migrationSafetyFramework.js';

// Mock logger
vi.mock('../../logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// Mock MongoDB
const mockCollection = {
  countDocuments: vi.fn(),
  find: vi.fn(),
  replaceOne: vi.fn(),
  insertOne: vi.fn(),
  updateOne: vi.fn(),
};

const mockDb = {
  collection: vi.fn(() => mockCollection),
};

vi.mock('../../db/mongodb.js', () => ({
  getDb: vi.fn(() => Promise.resolve(mockDb)),
}));

describe('SafeMigration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('dryRun', () => {
    it('should preview migration without making changes', async () => {
      const migration = new AddNotificationPreferencesMigration();

      const sampleDocs = [
        { _id: '1', email: 'user1@example.com' },
        { _id: '2', email: 'user2@example.com' },
      ];

      mockCollection.countDocuments.mockResolvedValue(10);
      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue(sampleDocs),
        }),
      });

      const report = await migration.dryRun({ sampleSize: 5 });

      expect(report.dryRun).toBe(true);
      expect(report.affectedRecords).toBe(10);
      expect(report.sampleChanges).toHaveLength(2);
      expect(report.sampleChanges[0].after).toHaveProperty(
        'notificationPreferences'
      );
    });

    it('should include rollback information', async () => {
      const migration = new AddNotificationPreferencesMigration();

      mockCollection.countDocuments.mockResolvedValue(5);
      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]),
        }),
      });

      const report = await migration.dryRun();

      expect(report.rollbackInfo).toBeDefined();
      expect(report.rollbackInfo.automated).toBe(true);
      expect(report.rollbackInfo.steps).toBeInstanceOf(Array);
    });

    it('should estimate migration duration', async () => {
      const migration = new AddNotificationPreferencesMigration();

      mockCollection.countDocuments.mockResolvedValue(1000);
      mockCollection.find.mockReturnValue({
        limit: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]),
        }),
      });

      const report = await migration.dryRun();

      expect(report.estimatedDuration).toBeDefined();
      expect(typeof report.estimatedDuration).toBe('string');
    });
  });

  describe('execute', () => {
    it('should execute migration successfully', async () => {
      const migration = new AddNotificationPreferencesMigration();

      const docs = [
        { _id: '1', email: 'user1@example.com' },
        { _id: '2', email: 'user2@example.com' },
      ];

      let cursorIndex = 0;
      const mockCursor = {
        hasNext: vi.fn(() => Promise.resolve(cursorIndex < docs.length)),
        next: vi.fn(() => Promise.resolve(docs[cursorIndex++])),
      };

      mockCollection.find.mockReturnValue(mockCursor);
      mockCollection.replaceOne.mockResolvedValue({ modifiedCount: 1 });
      mockCollection.countDocuments.mockResolvedValue(0); // Post-validation

      const report = await migration.execute();

      expect(report.dryRun).toBe(false);
      expect(report.modifiedCount).toBe(2);
      expect(report.failedCount).toBe(0);
      expect(report.postValidation.valid).toBe(true);
    });

    it('should handle failures gracefully', async () => {
      const migration = new AddNotificationPreferencesMigration();

      const docs = [{ _id: '1', email: 'user1@example.com' }];

      let cursorIndex = 0;
      const mockCursor = {
        hasNext: vi.fn(() => Promise.resolve(cursorIndex < docs.length)),
        next: vi.fn(() => Promise.resolve(docs[cursorIndex++])),
      };

      mockCollection.find.mockReturnValue(mockCursor);
      mockCollection.replaceOne.mockRejectedValue(
        new Error('Database error')
      );
      mockCollection.countDocuments.mockResolvedValue(1);

      const report = await migration.execute();

      expect(report.failedCount).toBe(1);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0].error).toBe('Database error');
    });

    it('should create and update checkpoints', async () => {
      const migration = new AddNotificationPreferencesMigration();

      const docs = Array.from({ length: 150 }, (_, i) => ({
        _id: String(i),
        email: `user${i}@example.com`,
      }));

      let cursorIndex = 0;
      const mockCursor = {
        hasNext: vi.fn(() => Promise.resolve(cursorIndex < docs.length)),
        next: vi.fn(() => Promise.resolve(docs[cursorIndex++])),
      };

      mockCollection.find.mockReturnValue(mockCursor);
      mockCollection.replaceOne.mockResolvedValue({ modifiedCount: 1 });
      mockCollection.countDocuments.mockResolvedValue(0);

      await migration.execute({ batchSize: 50 });

      // Should have created checkpoint
      expect(mockCollection.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({
          migrationId: migration.id,
          completed: false,
        })
      );

      // Should have updated checkpoint multiple times
      expect(mockCollection.updateOne).toHaveBeenCalled();

      // Should have marked checkpoint complete
      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          $set: expect.objectContaining({
            completed: true,
          }),
        })
      );
    });

    it('should fail pre-validation when forced', async () => {
      const migration = new SafeMigration({
        id: 'test-migration',
        name: 'Test',
        description: 'Test migration',
        targetCollection: 'test',
        version: '1.0.0',
      });

      migration.getAffectedQuery = vi.fn().mockResolvedValue({});
      migration.preValidate = vi.fn().mockResolvedValue({
        valid: false,
        errors: ['Pre-validation failed'],
        warnings: [],
        stats: {},
      });

      await expect(migration.execute()).rejects.toThrow(
        'Pre-validation failed'
      );
    });
  });

  describe('postValidate', () => {
    it('should detect incomplete migrations', async () => {
      const migration = new AddNotificationPreferencesMigration();

      mockCollection.countDocuments.mockResolvedValue(5);

      const result = await migration.postValidate();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('5 documents not migrated');
      expect(result.stats.remainingUnmigrated).toBe(5);
    });

    it('should pass when all documents migrated', async () => {
      const migration = new AddNotificationPreferencesMigration();

      mockCollection.countDocuments.mockResolvedValue(0);

      const result = await migration.postValidate();

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('AddNotificationPreferencesMigration', () => {
    it('should add default notification preferences', async () => {
      const migration = new AddNotificationPreferencesMigration();

      const doc = {
        _id: '1',
        email: 'user@example.com',
        name: 'Test User',
      };

      const transformed = await migration.transform(doc);

      expect(transformed).toHaveProperty('notificationPreferences');
      expect(transformed.notificationPreferences).toEqual({
        email: true,
        purchases: true,
        updates: false,
        marketing: false,
      });
      expect(transformed.migrationVersion).toBe('1.0.0');
    });

    it('should warn about profiles without email', async () => {
      const migration = new AddNotificationPreferencesMigration();

      mockCollection.countDocuments.mockResolvedValue(3);

      const result = await migration.preValidate();

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('3 profiles have no email');
    });
  });
});
