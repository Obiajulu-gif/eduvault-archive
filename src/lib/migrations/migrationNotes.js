/**
 * Migration Notes and Compatibility Fixtures (Issue #2)
 * 
 * Provides:
 * 1. Versioned migration notes with compatibility matrix
 * 2. Rollback compatibility fixtures and verification
 * 3. Forward/backward compatibility guarantees
 * 4. Migration dependency tracking
 * 5. Automated compatibility testing
 */

import { getDb } from '../mongodb.js';
import logger from '../logger.js';
import { COLLECTIONS } from '../backend/schemaContracts.js';

export const MIGRATION_NOTE_VERSION = 'v1';

/**
 * Migration compatibility levels
 */
export const CompatibilityLevel = Object.freeze({
  FULL: 'full',           // Fully compatible, no data transformation needed
  FORWARD: 'forward',     // Forward compatible only (old code can't read new data)
  BACKWARD: 'backward',   // Backward compatible only (new code can read old data)
  BREAKING: 'breaking',   // Breaking change, requires coordinated deployment
});

/**
 * Migration phases for staged rollouts
 */
export const MigrationPhase = Object.freeze({
  DRAFT: 'draft',
  TESTING: 'testing',
  STAGED: 'staged',
  DEPLOYED: 'deployed',
  COMPLETED: 'completed',
  ROLLED_BACK: 'rolled_back',
});

/**
 * Error class for migration note operations
 */
export class MigrationNoteError extends Error {
  constructor(message, code = 'MIGRATION_NOTE_ERROR', details = null) {
    super(message);
    this.name = 'MigrationNoteError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Create a versioned migration note
 */
export async function createMigrationNote({
  migrationId,
  version,
  title,
  description,
  compatibilityLevel = CompatibilityLevel.FULL,
  targetCollections = [],
  dependencies = [],
  forwardFixtures = [],
  rollbackFixtures = [],
  breakingChanges = [],
  deploymentNotes = '',
  testingNotes = '',
  actor,
  estimatedDuration = null,
}) {
  if (!migrationId || !version || !title) {
    throw new MigrationNoteError(
      'migrationId, version, and title are required',
      'MISSING_REQUIRED_FIELDS'
    );
  }

  const db = await getDb();
  const collection = db.collection(COLLECTIONS.migrationNotes || 'migration_notes');

  // Check for duplicate
  const existing = await collection.findOne({ migrationId, version });
  if (existing) {
    throw new MigrationNoteError(
      `Migration note already exists: ${migrationId} v${version}`,
      'DUPLICATE_MIGRATION_NOTE'
    );
  }

  // Validate dependencies exist
  for (const depId of dependencies) {
    const depExists = await collection.findOne({ migrationId: depId });
    if (!depExists) {
      logger.warn({ migrationId, dependency: depId }, 'Migration dependency not found');
    }
  }

  const note = {
    noteVersion: MIGRATION_NOTE_VERSION,
    migrationId: String(migrationId),
    version: String(version),
    title: String(title),
    description: String(description),
    compatibilityLevel: String(compatibilityLevel),
    targetCollections: Array.isArray(targetCollections) ? targetCollections : [],
    dependencies: Array.isArray(dependencies) ? dependencies : [],
    forwardFixtures: Array.isArray(forwardFixtures) ? forwardFixtures : [],
    rollbackFixtures: Array.isArray(rollbackFixtures) ? rollbackFixtures : [],
    breakingChanges: Array.isArray(breakingChanges) ? breakingChanges : [],
    deploymentNotes: String(deploymentNotes),
    testingNotes: String(testingNotes),
    estimatedDuration,
    phase: MigrationPhase.DRAFT,
    createdAt: new Date(),
    createdBy: actor ? String(actor.id || actor.sub || actor) : 'system',
    updatedAt: new Date(),
  };

  await collection.insertOne(note);
  
  logger.info(
    { migrationId, version, compatibilityLevel },
    '[MigrationNotes] Created migration note'
  );

  return note;
}

/**
 * Update migration phase
 */
export async function updateMigrationPhase({
  migrationId,
  version,
  phase,
  notes = '',
  actor,
}) {
  if (!migrationId || !version || !phase) {
    throw new MigrationNoteError(
      'migrationId, version, and phase are required',
      'MISSING_REQUIRED_FIELDS'
    );
  }

  if (!Object.values(MigrationPhase).includes(phase)) {
    throw new MigrationNoteError(
      `Invalid phase: ${phase}`,
      'INVALID_PHASE'
    );
  }

  const db = await getDb();
  const collection = db.collection(COLLECTIONS.migrationNotes || 'migration_notes');

  const result = await collection.updateOne(
    { migrationId: String(migrationId), version: String(version) },
    {
      $set: {
        phase: String(phase),
        updatedAt: new Date(),
        updatedBy: actor ? String(actor.id || actor.sub || actor) : 'system',
      },
      $push: {
        phaseHistory: {
          phase: String(phase),
          notes: String(notes),
          timestamp: new Date(),
          actor: actor ? String(actor.id || actor.sub || actor) : 'system',
        },
      },
    }
  );

  if (result.matchedCount === 0) {
    throw new MigrationNoteError(
      `Migration note not found: ${migrationId} v${version}`,
      'MIGRATION_NOTE_NOT_FOUND',
      404
    );
  }

  logger.info(
    { migrationId, version, phase },
    '[MigrationNotes] Updated migration phase'
  );

  return result;
}

/**
 * Get compatibility matrix for a collection
 */
export async function getCompatibilityMatrix(targetCollection) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.migrationNotes || 'migration_notes');

  const notes = await collection
    .find({ targetCollections: targetCollection })
    .sort({ createdAt: 1 })
    .toArray();

  const matrix = {
    collection: targetCollection,
    migrations: [],
    compatibilityGraph: {},
    breakingChangeVersions: [],
  };

  for (const note of notes) {
    matrix.migrations.push({
      migrationId: note.migrationId,
      version: note.version,
      compatibilityLevel: note.compatibilityLevel,
      phase: note.phase,
      dependencies: note.dependencies,
    });

    if (note.compatibilityLevel === CompatibilityLevel.BREAKING) {
      matrix.breakingChangeVersions.push(note.version);
    }

    // Build dependency graph
    matrix.compatibilityGraph[note.migrationId] = {
      version: note.version,
      dependencies: note.dependencies,
      compatibilityLevel: note.compatibilityLevel,
    };
  }

  return matrix;
}

/**
 * Validate compatibility fixtures
 */
export async function validateCompatibilityFixtures({
  migrationId,
  version,
  fixtureType = 'forward', // 'forward' or 'rollback'
}) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.migrationNotes || 'migration_notes');

  const note = await collection.findOne({ migrationId, version });
  if (!note) {
    throw new MigrationNoteError(
      `Migration note not found: ${migrationId} v${version}`,
      'MIGRATION_NOTE_NOT_FOUND',
      404
    );
  }

  const fixtures = fixtureType === 'forward' 
    ? note.forwardFixtures 
    : note.rollbackFixtures;

  if (!fixtures || fixtures.length === 0) {
    return {
      valid: true,
      warnings: [`No ${fixtureType} fixtures defined`],
      fixtures: [],
    };
  }

  const validationResults = [];
  const errors = [];
  const warnings = [];

  for (const fixture of fixtures) {
    try {
      // Validate fixture structure
      if (!fixture.name || !fixture.before || !fixture.after) {
        errors.push(`Invalid fixture structure: ${JSON.stringify(fixture)}`);
        continue;
      }

      // Validate that transformation is reversible (for rollback)
      if (fixtureType === 'rollback') {
        const beforeKeys = Object.keys(fixture.before);
        const afterKeys = Object.keys(fixture.after);
        
        // Check for data loss
        const lostKeys = beforeKeys.filter(k => !(k in fixture.after));
        if (lostKeys.length > 0) {
          warnings.push(
            `Fixture "${fixture.name}" loses keys during rollback: ${lostKeys.join(', ')}`
          );
        }
      }

      validationResults.push({
        name: fixture.name,
        valid: true,
        fixture,
      });
    } catch (error) {
      errors.push(`Fixture validation failed: ${error.message}`);
      validationResults.push({
        name: fixture.name,
        valid: false,
        error: error.message,
      });
    }
  }

  logger.info(
    {
      migrationId,
      version,
      fixtureType,
      fixtureCount: fixtures.length,
      errors: errors.length,
      warnings: warnings.length,
    },
    '[MigrationNotes] Validated compatibility fixtures'
  );

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    fixtures: validationResults,
  };
}

/**
 * Test migration compatibility using fixtures
 */
export async function testMigrationCompatibility({
  migrationId,
  version,
  transform,
  rollbackTransform = null,
}) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.migrationNotes || 'migration_notes');

  const note = await collection.findOne({ migrationId, version });
  if (!note) {
    throw new MigrationNoteError(
      `Migration note not found: ${migrationId} v${version}`,
      'MIGRATION_NOTE_NOT_FOUND',
      404
    );
  }

  const results = {
    migrationId,
    version,
    forwardTests: [],
    rollbackTests: [],
    passed: true,
  };

  // Test forward compatibility
  for (const fixture of note.forwardFixtures) {
    try {
      const transformed = await transform(fixture.before);
      const matches = JSON.stringify(transformed) === JSON.stringify(fixture.after);

      results.forwardTests.push({
        name: fixture.name,
        passed: matches,
        before: fixture.before,
        expected: fixture.after,
        actual: transformed,
      });

      if (!matches) {
        results.passed = false;
      }
    } catch (error) {
      results.forwardTests.push({
        name: fixture.name,
        passed: false,
        error: error.message,
      });
      results.passed = false;
    }
  }

  // Test rollback compatibility if transform provided
  if (rollbackTransform) {
    for (const fixture of note.rollbackFixtures) {
      try {
        const transformed = await rollbackTransform(fixture.before);
        const matches = JSON.stringify(transformed) === JSON.stringify(fixture.after);

        results.rollbackTests.push({
          name: fixture.name,
          passed: matches,
          before: fixture.before,
          expected: fixture.after,
          actual: transformed,
        });

        if (!matches) {
          results.passed = false;
        }
      } catch (error) {
        results.rollbackTests.push({
          name: fixture.name,
          passed: false,
          error: error.message,
        });
        results.passed = false;
      }
    }
  }

  logger.info(
    {
      migrationId,
      version,
      forwardTests: results.forwardTests.length,
      rollbackTests: results.rollbackTests.length,
      passed: results.passed,
    },
    '[MigrationNotes] Tested migration compatibility'
  );

  return results;
}

/**
 * Get migration dependencies in execution order
 */
export async function getMigrationDependencies(migrationId) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.migrationNotes || 'migration_notes');

  const note = await collection.findOne({ migrationId });
  if (!note) {
    throw new MigrationNoteError(
      `Migration note not found: ${migrationId}`,
      'MIGRATION_NOTE_NOT_FOUND',
      404
    );
  }

  const dependencies = [];
  const visited = new Set();

  async function resolveDeps(id) {
    if (visited.has(id)) {
      return; // Prevent circular dependencies
    }
    visited.add(id);

    const dep = await collection.findOne({ migrationId: id });
    if (!dep) {
      logger.warn({ migrationId: id }, 'Migration dependency not found');
      return;
    }

    // Recursively resolve dependencies
    for (const depId of dep.dependencies) {
      await resolveDeps(depId);
    }

    dependencies.push({
      migrationId: dep.migrationId,
      version: dep.version,
      phase: dep.phase,
    });
  }

  for (const depId of note.dependencies) {
    await resolveDeps(depId);
  }

  return dependencies;
}

/**
 * Export compatibility report
 */
export async function exportCompatibilityReport({
  targetCollection = null,
  includeFixtures = false,
}) {
  const db = await getDb();
  const collection = db.collection(COLLECTIONS.migrationNotes || 'migration_notes');

  const query = targetCollection 
    ? { targetCollections: targetCollection }
    : {};

  const notes = await collection
    .find(query)
    .sort({ createdAt: 1 })
    .toArray();

  const report = {
    reportType: 'migration_compatibility',
    generatedAt: new Date(),
    totalMigrations: notes.length,
    byCollection: {},
    byPhase: {},
    byCompatibilityLevel: {},
    breakingChanges: [],
  };

  for (const note of notes) {
    // Group by collection
    for (const col of note.targetCollections) {
      if (!report.byCollection[col]) {
        report.byCollection[col] = [];
      }
      report.byCollection[col].push({
        migrationId: note.migrationId,
        version: note.version,
        compatibilityLevel: note.compatibilityLevel,
        phase: note.phase,
      });
    }

    // Group by phase
    if (!report.byPhase[note.phase]) {
      report.byPhase[note.phase] = 0;
    }
    report.byPhase[note.phase]++;

    // Group by compatibility level
    if (!report.byCompatibilityLevel[note.compatibilityLevel]) {
      report.byCompatibilityLevel[note.compatibilityLevel] = 0;
    }
    report.byCompatibilityLevel[note.compatibilityLevel]++;

    // Track breaking changes
    if (note.compatibilityLevel === CompatibilityLevel.BREAKING) {
      report.breakingChanges.push({
        migrationId: note.migrationId,
        version: note.version,
        title: note.title,
        breakingChanges: note.breakingChanges,
        phase: note.phase,
      });
    }
  }

  if (includeFixtures) {
    report.migrations = notes.map(note => ({
      migrationId: note.migrationId,
      version: note.version,
      title: note.title,
      forwardFixtures: note.forwardFixtures,
      rollbackFixtures: note.rollbackFixtures,
    }));
  }

  return report;
}

export default {
  createMigrationNote,
  updateMigrationPhase,
  getCompatibilityMatrix,
  validateCompatibilityFixtures,
  testMigrationCompatibility,
  getMigrationDependencies,
  exportCompatibilityReport,
  CompatibilityLevel,
  MigrationPhase,
};
