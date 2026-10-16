/**
 * Migration Safety Framework
 * Issue #809: Create migration safety framework with dry-run, rollback notes, and post-checks
 *
 * Provides guardrails for schema and data migrations including:
 * - Dry-run support with impact preview
 * - Post-migration validation checks
 * - Rollback and forward-fix procedures
 * - Safety checks for risky changes
 */

import { getDb } from '../db/mongodb.js';
import logger from '../logger.js';

/**
 * Migration validation result structure
 * @typedef {object} ValidationResult
 * @property {boolean} valid - Whether validation passed
 * @property {string[]} errors - List of validation errors
 * @property {string[]} warnings - List of validation warnings
 * @property {object} stats - Validation statistics
 */

/**
 * Migration execution report
 * @typedef {object} MigrationReport
 * @property {string} migrationId - Unique migration identifier
 * @property {boolean} dryRun - Whether this was a dry run
 * @property {number} affectedRecords - Number of records that would be/were affected
 * @property {object[]} sampleChanges - Sample of changes to be made
 * @property {Date} executedAt - Execution timestamp
 * @property {ValidationResult} preValidation - Pre-migration validation results
 * @property {ValidationResult} postValidation - Post-migration validation results
 * @property {object} rollbackInfo - Rollback procedure information
 */

/**
 * Base Migration Class
 * All migrations should extend this class and implement required methods
 */
export class SafeMigration {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.description = config.description;
    this.targetCollection = config.targetCollection;
    this.version = config.version;
    this.dangerous = config.dangerous || false; // Flag for destructive operations
  }

  /**
   * Preview migration impact without making changes
   * @param {object} options - Dry run options
   * @returns {Promise<MigrationReport>}
   */
  async dryRun(options = {}) {
    const db = await getDb();
    const collection = db.collection(this.targetCollection);

    logger.info(`[Migration ${this.id}] Starting dry-run preview`);

    // Find affected documents
    const query = await this.getAffectedQuery();
    const affectedCount = await collection.countDocuments(query);

    // Get sample records to show impact
    const sampleSize = Math.min(options.sampleSize || 10, affectedCount);
    const samples = await collection.find(query).limit(sampleSize).toArray();

    const sampleChanges = [];
    for (const doc of samples) {
      const before = this.extractRelevantFields(doc);
      const after = this.extractRelevantFields(await this.transform(doc));
      sampleChanges.push({
        _id: String(doc._id),
        before,
        after,
        changes: this.diffObjects(before, after),
      });
    }

    // Run pre-migration validation
    const preValidation = await this.preValidate();

    const report = {
      migrationId: this.id,
      name: this.name,
      description: this.description,
      dryRun: true,
      dangerous: this.dangerous,
      affectedRecords: affectedCount,
      sampleChanges,
      executedAt: new Date(),
      preValidation,
      rollbackInfo: this.getRollbackProcedure(),
      estimatedDuration: this.estimateDuration(affectedCount),
    };

    logger.info(`[Migration ${this.id}] Dry-run complete: ${affectedCount} records affected`);

    return report;
  }

  /**
   * Execute migration with safety checks
   * @param {object} options - Execution options
   * @returns {Promise<MigrationReport>}
   */
  async execute(options = {}) {
    const db = await getDb();
    const collection = db.collection(this.targetCollection);
    const batchSize = options.batchSize || 100;

    logger.info(`[Migration ${this.id}] Starting execution`);

    // Pre-flight validation
    const preValidation = await this.preValidate();
    if (!preValidation.valid && !options.force) {
      throw new Error(
        `Pre-validation failed: ${preValidation.errors.join(', ')}`
      );
    }

    // Create checkpoint for resumability
    const checkpoint = await this.createCheckpoint();

    const query = await this.getAffectedQuery();
    let processedCount = 0;
    let modifiedCount = 0;
    let failedCount = 0;
    const errors = [];

    // Process in batches
    const cursor = collection.find(query).batchSize(batchSize);

    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      processedCount++;

      try {
        const transformed = await this.transform(doc);
        const result = await collection.replaceOne(
          { _id: doc._id },
          transformed
        );

        if (result.modifiedCount > 0) {
          modifiedCount++;
        }

        // Update checkpoint periodically
        if (processedCount % batchSize === 0) {
          await this.updateCheckpoint(checkpoint, {
            processedCount,
            modifiedCount,
            lastProcessedId: doc._id,
          });
        }
      } catch (error) {
        failedCount++;
        errors.push({
          _id: String(doc._id),
          error: error.message,
        });
        logger.error(`[Migration ${this.id}] Failed to migrate document`, {
          _id: doc._id,
          error: error.message,
        });

        if (errors.length > 100) {
          // Too many errors, abort
          throw new Error(
            `Migration aborted: ${failedCount} failures exceeded threshold`
          );
        }
      }
    }

    // Post-migration validation
    const postValidation = await this.postValidate();

    // Mark checkpoint as complete
    await this.completeCheckpoint(checkpoint);

    const report = {
      migrationId: this.id,
      name: this.name,
      dryRun: false,
      affectedRecords: processedCount,
      modifiedCount,
      failedCount,
      errors: errors.slice(0, 10), // Include first 10 errors
      executedAt: new Date(),
      preValidation,
      postValidation,
      rollbackInfo: this.getRollbackProcedure(),
    };

    logger.info(`[Migration ${this.id}] Execution complete`, {
      processed: processedCount,
      modified: modifiedCount,
      failed: failedCount,
    });

    return report;
  }

  /**
   * Methods to be implemented by specific migrations
   */

  /**
   * Get query to find affected documents
   * @returns {Promise<object>} MongoDB query
   */
  async getAffectedQuery() {
    throw new Error('getAffectedQuery() must be implemented');
  }

  /**
   * Transform a document
   * @param {object} doc - Document to transform
   * @returns {Promise<object>} Transformed document
   */
  async transform(doc) {
    throw new Error('transform() must be implemented');
  }

  /**
   * Validate before migration
   * @returns {Promise<ValidationResult>}
   */
  async preValidate() {
    return {
      valid: true,
      errors: [],
      warnings: [],
      stats: {},
    };
  }

  /**
   * Validate after migration
   * @returns {Promise<ValidationResult>}
   */
  async postValidate() {
    const db = await getDb();
    const collection = db.collection(this.targetCollection);

    // Default post-validation: check for incomplete migrations
    const query = await this.getAffectedQuery();
    const remaining = await collection.countDocuments(query);

    return {
      valid: remaining === 0,
      errors: remaining > 0 ? [`${remaining} documents not migrated`] : [],
      warnings: [],
      stats: {
        remainingUnmigrated: remaining,
      },
    };
  }

  /**
   * Get rollback procedure documentation
   * @returns {object} Rollback information
   */
  getRollbackProcedure() {
    return {
      automated: false,
      procedure: 'No automated rollback available. Manual intervention required.',
      steps: [
        '1. Review migration logs and identify affected records',
        '2. Restore from backup if available',
        '3. Re-run inverse migration if implemented',
      ],
    };
  }

  /**
   * Estimate migration duration
   * @param {number} recordCount - Number of records
   * @returns {string} Estimated duration
   */
  estimateDuration(recordCount) {
    const secondsPerRecord = 0.01; // Adjust based on operation complexity
    const totalSeconds = recordCount * secondsPerRecord;

    if (totalSeconds < 60) return `~${Math.ceil(totalSeconds)} seconds`;
    if (totalSeconds < 3600) return `~${Math.ceil(totalSeconds / 60)} minutes`;
    return `~${Math.ceil(totalSeconds / 3600)} hours`;
  }

  /**
   * Helper methods
   */

  extractRelevantFields(doc) {
    // Override to extract only fields relevant to the migration
    return doc;
  }

  diffObjects(before, after) {
    const changes = [];
    const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

    for (const key of allKeys) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        changes.push({
          field: key,
          from: before[key],
          to: after[key],
        });
      }
    }

    return changes;
  }

  async createCheckpoint() {
    const db = await getDb();
    const checkpoints = db.collection('migration_checkpoints');

    const checkpoint = {
      migrationId: this.id,
      startedAt: new Date(),
      processedCount: 0,
      modifiedCount: 0,
      lastProcessedId: null,
      completed: false,
    };

    await checkpoints.insertOne(checkpoint);
    return checkpoint;
  }

  async updateCheckpoint(checkpoint, updates) {
    const db = await getDb();
    const checkpoints = db.collection('migration_checkpoints');

    await checkpoints.updateOne(
      { _id: checkpoint._id },
      {
        $set: {
          ...updates,
          updatedAt: new Date(),
        },
      }
    );
  }

  async completeCheckpoint(checkpoint) {
    const db = await getDb();
    const checkpoints = db.collection('migration_checkpoints');

    await checkpoints.updateOne(
      { _id: checkpoint._id },
      {
        $set: {
          completed: true,
          completedAt: new Date(),
        },
      }
    );
  }
}

/**
 * Example Migration: Add default notification preferences
 */
export class AddNotificationPreferencesMigration extends SafeMigration {
  constructor() {
    super({
      id: 'add_notification_preferences_001',
      name: 'Add Notification Preferences',
      description: 'Add default notification preferences to user profiles',
      targetCollection: 'profiles',
      version: '1.0.0',
      dangerous: false,
    });
  }

  async getAffectedQuery() {
    return {
      notificationPreferences: { $exists: false },
    };
  }

  async transform(doc) {
    return {
      ...doc,
      notificationPreferences: {
        email: true,
        purchases: true,
        updates: false,
        marketing: false,
      },
      migrationVersion: this.version,
    };
  }

  extractRelevantFields(doc) {
    return {
      _id: doc._id,
      email: doc.email,
      notificationPreferences: doc.notificationPreferences,
    };
  }

  async preValidate() {
    const db = await getDb();
    const profiles = db.collection(this.targetCollection);

    // Check for profiles without email
    const profilesWithoutEmail = await profiles.countDocuments({
      email: { $exists: false },
      notificationPreferences: { $exists: false },
    });

    return {
      valid: profilesWithoutEmail === 0,
      errors: [],
      warnings:
        profilesWithoutEmail > 0
          ? [
              `${profilesWithoutEmail} profiles have no email and will receive default preferences`,
            ]
          : [],
      stats: {
        profilesWithoutEmail,
      },
    };
  }

  getRollbackProcedure() {
    return {
      automated: true,
      procedure: 'Remove notificationPreferences field from all profiles',
      steps: [
        '1. Run rollback migration to remove notificationPreferences',
        '2. Verify all profiles have field removed',
      ],
    };
  }
}

export default SafeMigration;
