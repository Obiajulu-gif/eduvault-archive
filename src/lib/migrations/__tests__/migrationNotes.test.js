/**
 * Tests for Migration Notes and Compatibility Fixtures
 * Issue #2
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createMigrationNote,
  updateMigrationPhase,
  getCompatibilityMatrix,
  validateCompatibilityFixtures,
  testMigrationCompatibility,
  getMigrationDependencies,
  exportCompatibilityReport,
  CompatibilityLevel,
  MigrationPhase,
  MigrationNoteError,
} from '../migrationNotes.js';

// Mock logger
vi.mock('../../logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

function createMockCollection(initialDocs = []) {
  const docs = [...initialDocs];

  return {
    _docs: docs,
    async findOne(query) {
      return docs.find((d) => {
        if (query.migrationId && query.version) {
          return d.migrationId === query.migrationId && d.version === query.version;
        }
        if (query.migrationId) {
          return d.migrationId === query.migrationId;
        }
        return true;
      }) || null;
    },
    find(query = {}) {
      let filtered = docs;
      if (query.targetCollections) {
        filtered = docs.filter(d => 
          d.targetCollections && d.targetCollections.includes(query.targetCollections)
        );
      }
      if (query.generatedAt) {
        // Handle date range queries
        filtered = docs;
      }
      return {
        sort() {
          return {
            toArray: async () => filtered,
          };
        },
        toArray: async () => filtered,
      };
    },
    async insertOne(doc) {
      docs.push({ ...doc });
      return { acknowledged: true, insertedId: doc.migrationId };
    },
    async updateOne(query, update) {
      const idx = docs.findIndex((d) => 
        d.migrationId === query.migrationId && d.version === query.version
      );
      if (idx >= 0) {
        if (update.$set) Object.assign(docs[idx], update.$set);
        if (update.$push) {
          const key = Object.keys(update.$push)[0];
          if (!docs[idx][key]) docs[idx][key] = [];
          docs[idx][key].push(update.$push[key]);
        }
        return { matchedCount: 1, modifiedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    },
  };
}

const mockDb = {
  collection: vi.fn(),
};

vi.mock('../../mongodb.js', () => ({
  getDb: vi.fn(() => Promise.resolve(mockDb)),
}));

describe('Migration Notes and Compatibility Fixtures', () => {
  let mockCollection;
  const adminActor = { id: 'admin_1', sub: 'admin_1', role: 'admin' };

  beforeEach(() => {
    mockCollection = createMockCollection([]);
    mockDb.collection.mockReturnValue(mockCollection);
    vi.clearAllMocks();
  });

  describe('Normal Path - Creating Migration Notes', () => {
    it('creates a migration note with all fields', async () => {
      const note = await createMigrationNote({
        migrationId: 'add_user_preferences',
        version: '1.0.0',
        title: 'Add User Notification Preferences',
        description: 'Adds notification preference fields to user profiles',
        compatibilityLevel: CompatibilityLevel.BACKWARD,
        targetCollections: ['profiles'],
        dependencies: [],
        forwardFixtures: [
          {
            name: 'basic_user',
            before: { _id: '1', email: 'test@example.com' },
            after: { 
              _id: '1', 
              email: 'test@example.com',
              notificationPreferences: { email: true }
            },
          },
        ],
        rollbackFixtures: [
          {
            name: 'basic_user',
            before: { 
              _id: '1', 
              email: 'test@example.com',
              notificationPreferences: { email: true }
            },
            after: { _id: '1', email: 'test@example.com' },
          },
        ],
        breakingChanges: [],
        deploymentNotes: 'Deploy during maintenance window',
        testingNotes: 'Test with sample user accounts',
        actor: adminActor,
        estimatedDuration: '5 minutes',
      });

      expect(note.migrationId).toBe('add_user_preferences');
      expect(note.version).toBe('1.0.0');
      expect(note.compatibilityLevel).toBe(CompatibilityLevel.BACKWARD);
      expect(note.phase).toBe(MigrationPhase.DRAFT);
      expect(note.forwardFixtures).toHaveLength(1);
      expect(note.rollbackFixtures).toHaveLength(1);
    });

    it('prevents duplicate migration notes', async () => {
      await createMigrationNote({
        migrationId: 'test_migration',
        version: '1.0.0',
        title: 'Test Migration',
        description: 'Test',
        actor: adminActor,
      });

      await expect(
        createMigrationNote({
          migrationId: 'test_migration',
          version: '1.0.0',
          title: 'Test Migration Duplicate',
          description: 'Test',
          actor: adminActor,
        })
      ).rejects.toThrow(MigrationNoteError);
    });
  });

  describe('Phase Transitions', () => {
    it('updates migration phase with history tracking', async () => {
      await createMigrationNote({
        migrationId: 'test_phase',
        version: '1.0.0',
        title: 'Test Phase Migration',
        description: 'Testing phase transitions',
        actor: adminActor,
      });

      await updateMigrationPhase({
        migrationId: 'test_phase',
        version: '1.0.0',
        phase: MigrationPhase.TESTING,
        notes: 'Moving to testing phase',
        actor: adminActor,
      });

      const note = await mockCollection.findOne({ 
        migrationId: 'test_phase',
        version: '1.0.0'
      });

      expect(note.phase).toBe(MigrationPhase.TESTING);
      expect(note.phaseHistory).toHaveLength(1);
      expect(note.phaseHistory[0].phase).toBe(MigrationPhase.TESTING);
    });

    it('rejects invalid phase transitions', async () => {
      await createMigrationNote({
        migrationId: 'test_invalid_phase',
        version: '1.0.0',
        title: 'Test',
        description: 'Test',
        actor: adminActor,
      });

      await expect(
        updateMigrationPhase({
          migrationId: 'test_invalid_phase',
          version: '1.0.0',
          phase: 'invalid_phase',
          actor: adminActor,
        })
      ).rejects.toThrow(MigrationNoteError);
    });
  });

  describe('Compatibility Fixtures Validation', () => {
    it('validates forward fixtures structure', async () => {
      await createMigrationNote({
        migrationId: 'test_fixtures',
        version: '1.0.0',
        title: 'Test Fixtures',
        description: 'Testing fixture validation',
        forwardFixtures: [
          {
            name: 'valid_fixture',
            before: { id: 1, value: 'old' },
            after: { id: 1, value: 'new', added: true },
          },
        ],
        actor: adminActor,
      });

      const result = await validateCompatibilityFixtures({
        migrationId: 'test_fixtures',
        version: '1.0.0',
        fixtureType: 'forward',
      });

      expect(result.valid).toBe(true);
      expect(result.fixtures).toHaveLength(1);
      expect(result.fixtures[0].valid).toBe(true);
    });

    it('detects data loss in rollback fixtures', async () => {
      await createMigrationNote({
        migrationId: 'test_rollback_loss',
        version: '1.0.0',
        title: 'Test Rollback Data Loss',
        description: 'Testing rollback validation',
        rollbackFixtures: [
          {
            name: 'lossy_rollback',
            before: { id: 1, value: 'data', important: 'info' },
            after: { id: 1, value: 'data' }, // 'important' field lost
          },
        ],
        actor: adminActor,
      });

      const result = await validateCompatibilityFixtures({
        migrationId: 'test_rollback_loss',
        version: '1.0.0',
        fixtureType: 'rollback',
      });

      expect(result.valid).toBe(true); // Still valid but has warnings
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('loses keys');
    });
  });

  describe('Migration Compatibility Testing', () => {
    it('tests forward migration with fixtures', async () => {
      const forwardTransform = async (doc) => ({
        ...doc,
        newField: 'added',
      });

      await createMigrationNote({
        migrationId: 'test_compat',
        version: '1.0.0',
        title: 'Test Compatibility',
        description: 'Testing compatibility',
        forwardFixtures: [
          {
            name: 'add_field',
            before: { id: 1, name: 'test' },
            after: { id: 1, name: 'test', newField: 'added' },
          },
        ],
        actor: adminActor,
      });

      const result = await testMigrationCompatibility({
        migrationId: 'test_compat',
        version: '1.0.0',
        transform: forwardTransform,
      });

      expect(result.passed).toBe(true);
      expect(result.forwardTests).toHaveLength(1);
      expect(result.forwardTests[0].passed).toBe(true);
    });

    it('detects transformation mismatches', async () => {
      const wrongTransform = async (doc) => ({
        ...doc,
        wrongField: 'incorrect',
      });

      await createMigrationNote({
        migrationId: 'test_mismatch',
        version: '1.0.0',
        title: 'Test Mismatch',
        description: 'Testing mismatch detection',
        forwardFixtures: [
          {
            name: 'mismatch',
            before: { id: 1 },
            after: { id: 1, correctField: 'expected' },
          },
        ],
        actor: adminActor,
      });

      const result = await testMigrationCompatibility({
        migrationId: 'test_mismatch',
        version: '1.0.0',
        transform: wrongTransform,
      });

      expect(result.passed).toBe(false);
      expect(result.forwardTests[0].passed).toBe(false);
    });
  });

  describe('Dependency Management', () => {
    it('resolves migration dependencies in order', async () => {
      // Create dependency chain: A -> B -> C
      await createMigrationNote({
        migrationId: 'migration_c',
        version: '1.0.0',
        title: 'Migration C',
        description: 'Base migration',
        dependencies: [],
        actor: adminActor,
      });

      await createMigrationNote({
        migrationId: 'migration_b',
        version: '1.0.0',
        title: 'Migration B',
        description: 'Depends on C',
        dependencies: ['migration_c'],
        actor: adminActor,
      });

      await createMigrationNote({
        migrationId: 'migration_a',
        version: '1.0.0',
        title: 'Migration A',
        description: 'Depends on B',
        dependencies: ['migration_b'],
        actor: adminActor,
      });

      const deps = await getMigrationDependencies('migration_a');

      expect(deps).toHaveLength(2);
      expect(deps[0].migrationId).toBe('migration_c');
      expect(deps[1].migrationId).toBe('migration_b');
    });
  });

  describe('Compatibility Matrix', () => {
    it('builds compatibility matrix for collection', async () => {
      await createMigrationNote({
        migrationId: 'profiles_v1',
        version: '1.0.0',
        title: 'Profiles V1',
        description: 'Initial schema',
        compatibilityLevel: CompatibilityLevel.FULL,
        targetCollections: ['profiles'],
        actor: adminActor,
      });

      await createMigrationNote({
        migrationId: 'profiles_v2',
        version: '2.0.0',
        title: 'Profiles V2',
        description: 'Breaking change',
        compatibilityLevel: CompatibilityLevel.BREAKING,
        targetCollections: ['profiles'],
        breakingChanges: ['Removed legacy fields'],
        actor: adminActor,
      });

      const matrix = await getCompatibilityMatrix('profiles');

      expect(matrix.migrations).toHaveLength(2);
      expect(matrix.breakingChangeVersions).toContain('2.0.0');
      expect(matrix.compatibilityGraph.profiles_v2.compatibilityLevel).toBe(
        CompatibilityLevel.BREAKING
      );
    });
  });

  describe('Compatibility Report', () => {
    it('generates comprehensive compatibility report', async () => {
      await createMigrationNote({
        migrationId: 'report_test_1',
        version: '1.0.0',
        title: 'Report Test 1',
        description: 'Test',
        compatibilityLevel: CompatibilityLevel.FORWARD,
        targetCollections: ['users'],
        phase: MigrationPhase.DEPLOYED,
        actor: adminActor,
      });

      await createMigrationNote({
        migrationId: 'report_test_2',
        version: '1.0.0',
        title: 'Report Test 2',
        description: 'Test',
        compatibilityLevel: CompatibilityLevel.BREAKING,
        targetCollections: ['orders'],
        phase: MigrationPhase.TESTING,
        breakingChanges: ['Schema change'],
        actor: adminActor,
      });

      const report = await exportCompatibilityReport({});

      expect(report.totalMigrations).toBe(2);
      expect(report.byPhase[MigrationPhase.DEPLOYED]).toBe(1);
      expect(report.byPhase[MigrationPhase.TESTING]).toBe(1);
      expect(report.byCompatibilityLevel[CompatibilityLevel.FORWARD]).toBe(1);
      expect(report.byCompatibilityLevel[CompatibilityLevel.BREAKING]).toBe(1);
      expect(report.breakingChanges).toHaveLength(1);
    });
  });

  describe('Failure and Edge Cases', () => {
    it('requires mandatory fields', async () => {
      await expect(
        createMigrationNote({
          // Missing migrationId
          version: '1.0.0',
          title: 'Test',
          actor: adminActor,
        })
      ).rejects.toThrow(MigrationNoteError);
    });

    it('handles missing migration note gracefully', async () => {
      await expect(
        validateCompatibilityFixtures({
          migrationId: 'nonexistent',
          version: '1.0.0',
        })
      ).rejects.toThrow(MigrationNoteError);
    });

    it('handles empty fixture arrays', async () => {
      await createMigrationNote({
        migrationId: 'empty_fixtures',
        version: '1.0.0',
        title: 'Empty Fixtures',
        description: 'No fixtures defined',
        forwardFixtures: [],
        actor: adminActor,
      });

      const result = await validateCompatibilityFixtures({
        migrationId: 'empty_fixtures',
        version: '1.0.0',
        fixtureType: 'forward',
      });

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain('No forward fixtures defined');
    });
  });

  describe('Authorization Paths', () => {
    it('records actor information in migration notes', async () => {
      const note = await createMigrationNote({
        migrationId: 'auth_test',
        version: '1.0.0',
        title: 'Authorization Test',
        description: 'Test actor recording',
        actor: adminActor,
      });

      expect(note.createdBy).toBe(adminActor.id);
    });

    it('tracks actors through phase transitions', async () => {
      await createMigrationNote({
        migrationId: 'phase_auth',
        version: '1.0.0',
        title: 'Phase Auth Test',
        description: 'Test',
        actor: adminActor,
      });

      await updateMigrationPhase({
        migrationId: 'phase_auth',
        version: '1.0.0',
        phase: MigrationPhase.TESTING,
        notes: 'Testing',
        actor: { id: 'admin_2', role: 'admin' },
      });

      const note = await mockCollection.findOne({
        migrationId: 'phase_auth',
        version: '1.0.0',
      });

      expect(note.phaseHistory[0].actor).toBe('admin_2');
    });
  });
});
