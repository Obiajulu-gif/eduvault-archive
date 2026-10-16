import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSensitiveDetails, getOperationalHealth } from '../../src/lib/backend/operationalHealth.js';

test('redactSensitiveDetails masks private keys, emails, and secrets', () => {
  const sensitiveRecord = {
    _id: 'sample-123',
    secretToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    stellarSecret: 'SB2A6Z6G5G6H7J8K9L0M1N2O3P4Q5R6S7T8U9V0W1X2Y3Z4A5B6C7D8E',
    evmPrivateKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    userEmail: 'creator.student@eduvault.org',
    regularField: 'safe data',
    nested: {
      passwordHash: '$2b$10$xyz',
      apiKey: 'key_12345',
      contactEmail: 'admin@eduvault.org',
    },
  };

  const redacted = redactSensitiveDetails(sensitiveRecord);

  assert.equal(redacted.secretToken, '[REDACTED]');
  assert.equal(redacted.stellarSecret, '[REDACTED_STELLAR_SECRET_KEY]');
  assert.equal(redacted.evmPrivateKey, '[REDACTED_EVM_PRIVATE_KEY]');
  assert.equal(redacted.userEmail.includes('***'), true);
  assert.equal(redacted.regularField, 'safe data');
  assert.equal(redacted.nested.passwordHash, '[REDACTED]');
  assert.equal(redacted.nested.apiKey, '[REDACTED]');
  assert.equal(redacted.nested.contactEmail.includes('***'), true);
});

test('getOperationalHealth accurately aggregates counts matching underlying records', async () => {
  // Create mock DB with controlled record counts
  const mockCollections = {
    outbox: {
      countDocuments: async (query) => (query.status === 'failed' ? 2 : 0),
      find: () => ({
        sort: () => ({
          limit: () => ({
            toArray: async () => [
              { _id: 'outbox-1', eventType: 'order_completed', lastError: 'Network timeout', createdAt: new Date() },
            ],
          }),
        }),
      }),
    },
    indexer_deadletters: {
      countDocuments: async () => 1,
      find: () => ({
        sort: () => ({
          limit: () => ({
            toArray: async () => [
              { _id: 'dl-1', reason: 'Invalid signature', error: 'Verification failed', createdAt: new Date() },
            ],
          }),
        }),
      }),
    },
    refunds: {
      countDocuments: async (query) => (query.status === 'failed' ? 1 : 0),
    },
    materials: {
      countDocuments: async (query) => {
        if (query.quarantineState === 'infected') return 1;
        if (query.pinVerified === false) return 3;
        return 0;
      },
    },
    checkout_intents: {
      countDocuments: async () => 4,
      find: () => ({
        limit: () => ({
          toArray: async () => [
            { _id: 'intent-1', createdAt: new Date(Date.now() - 7200000) },
          ],
        }),
      }),
    },
    storage_jobs: {
      countDocuments: async () => 0,
    },
    purchases: {
      countDocuments: async () => 2,
    },
    download_access_logs: {
      countDocuments: async () => 15,
    },
    users: {
      countDocuments: async (query) => (query.isSuspended ? 1 : 0),
    },
  };

  const mockDb = {
    collection: (name) => mockCollections[name] || { countDocuments: async () => 0 },
  };

  const report = await getOperationalHealth(mockDb);

  assert.equal(report.status, 'critical'); // because failedOutbox > 0
  assert.equal(report.indicators.unresolvedFailures.failedOutbox, 2);
  assert.equal(report.indicators.unresolvedFailures.unresolvedDeadletters, 1);
  assert.equal(report.indicators.unresolvedFailures.failedRefunds, 1);
  assert.equal(report.indicators.unresolvedFailures.quarantinedFiles, 1);
  assert.equal(report.indicators.unresolvedFailures.total, 5);

  assert.equal(report.indicators.staleJobs.staleIntents, 4);
  assert.equal(report.indicators.reconciliationDrift.purchaseDrift, 2);
  assert.equal(report.indicators.reconciliationDrift.unverifiedPins, 3);
  assert.equal(report.indicators.userImpactingIncidents.recentAccessDenials, 15);
  assert.equal(report.indicators.userImpactingIncidents.suspendedUsers, 1);

  assert.equal(report.actionableItems.unresolvedExceptions.length, 2);
  assert.equal(report.actionableItems.unresolvedExceptions[0].investigationUrl, '/admin/outbox/outbox-1');
});
