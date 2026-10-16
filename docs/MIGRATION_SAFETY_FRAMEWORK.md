# Migration Safety Framework

Issue #809: Create migration safety framework with dry-run, rollback notes, and post-checks

## Overview

The Migration Safety Framework provides guardrails for schema and data migrations, enabling contributors to preview impact, validate assumptions, and recover from partial rollout failures.

## Features

- **Dry-run Support**: Preview migration impact before execution
- **Post-migration Validation**: Detect incomplete or inconsistent results
- **Rollback Procedures**: Document and execute rollback steps
- **Resumable Execution**: Checkpoint-based resumption for interrupted migrations
- **Batch Processing**: Process large datasets in manageable batches
- **Audit Trail**: Complete logging of all migration activities

## Usage

### Creating a Migration

Extend the `SafeMigration` class and implement required methods:

```javascript
import { SafeMigration } from '../lib/migrations/migrationSafetyFramework.js';

class MyCustomMigration extends SafeMigration {
  constructor() {
    super({
      id: 'my_migration_001',
      name: 'My Custom Migration',
      description: 'Description of what this migration does',
      targetCollection: 'materials',
      version: '1.0.0',
      dangerous: false, // Set to true for destructive operations
    });
  }

  async getAffectedQuery() {
    return { fieldToMigrate: { $exists: false } };
  }

  async transform(doc) {
    return {
      ...doc,
      fieldToMigrate: 'defaultValue',
      migrationVersion: this.version,
    };
  }

  extractRelevantFields(doc) {
    return {
      _id: doc._id,
      fieldToMigrate: doc.fieldToMigrate,
    };
  }

  async preValidate() {
    // Custom pre-validation logic
    return {
      valid: true,
      errors: [],
      warnings: [],
      stats: {},
    };
  }

  getRollbackProcedure() {
    return {
      automated: true,
      procedure: 'Remove fieldToMigrate from all documents',
      steps: [
        '1. Run rollback script',
        '2. Verify field removal',
      ],
    };
  }
}
```

### Running a Migration

#### Dry Run (Preview)

```javascript
const migration = new MyCustomMigration();
const report = await migration.dryRun({ sampleSize: 10 });

console.log('Affected records:', report.affectedRecords);
console.log('Sample changes:', report.sampleChanges);
console.log('Estimated duration:', report.estimatedDuration);
```

#### Execute Migration

```javascript
const migration = new MyCustomMigration();
const report = await migration.execute({
  batchSize: 100, // Process 100 docs at a time
});

console.log('Modified count:', report.modifiedCount);
console.log('Failed count:', report.failedCount);
console.log('Post-validation:', report.postValidation);
```

## Migration Workflow

1. **Design**: Create migration class extending `SafeMigration`
2. **Dry-run**: Test with `dryRun()` to preview changes
3. **Review**: Examine sample changes and validation results
4. **Execute**: Run migration with `execute()`
5. **Validate**: Check post-migration validation results
6. **Monitor**: Review checkpoint progress for long-running migrations

## Rollback

Migrations can include automated rollback procedures:

```javascript
getRollbackProcedure() {
  return {
    automated: true,
    procedure: 'Description of rollback process',
    steps: [
      '1. First step',
      '2. Second step',
      '3. Verification step',
    ],
  };
}
```

## Testing

Comprehensive test coverage ensures migration safety:

- Dry-run preview tests
- Execution success scenarios
- Failure handling tests
- Checkpoint and resumption tests
- Validation tests

Run tests:

```bash
npm run test -- src/lib/migrations/__tests__/migrationSafetyFramework.test.js
```

## Best Practices

1. **Always dry-run first**: Never execute a migration without previewing
2. **Start small**: Test on a subset before running on production
3. **Monitor progress**: Check checkpoint data for long-running migrations
4. **Document rollback**: Provide clear rollback steps
5. **Validate thoroughly**: Implement comprehensive pre and post-validation
6. **Handle failures gracefully**: Ensure partial failures don't corrupt data

## Example Migrations

### Add Notification Preferences

```javascript
const migration = new AddNotificationPreferencesMigration();
await migration.dryRun();
await migration.execute();
```

This migration adds default notification preferences to user profiles.

## API Reference

### SafeMigration Methods

- `dryRun(options)`: Preview migration impact
- `execute(options)`: Run migration
- `preValidate()`: Validate before migration
- `postValidate()`: Validate after migration
- `transform(doc)`: Transform a single document
- `getAffectedQuery()`: Query for affected documents
- `getRollbackProcedure()`: Document rollback steps

### Configuration Options

- `batchSize`: Documents per batch (default: 100)
- `sampleSize`: Dry-run sample size (default: 10)
- `maxBatches`: Limit for testing (default: Infinity)
- `force`: Skip pre-validation (default: false)

## Integration

The framework integrates with:

- MongoDB for data storage
- Checkpoint system for resumability
- Audit logging for tracking
- Logger for monitoring

## Support

For issues or questions about migrations:

1. Check existing migrations in `src/lib/migrations/`
2. Review test examples
3. Consult framework documentation
4. Open an issue for guidance
