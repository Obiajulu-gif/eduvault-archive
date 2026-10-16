import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DOMAIN_EVENT_CONTRACTS,
  validateEventPayload,
  getCrossServiceBoundarySummary,
  FAILURE_STRATEGIES,
  DOMAINS,
} from '../../src/lib/backend/eventContractMap.js';

describe('Cross-Service Contract Map & Boundary Registry (#960)', () => {
  test('all registered contracts define required schema metadata and boundaries', () => {
    const contracts = Object.values(DOMAIN_EVENT_CONTRACTS);
    assert.ok(contracts.length >= 6);

    for (const contract of contracts) {
      assert.ok(contract.eventType, 'Event type must be defined');
      assert.ok(Object.values(DOMAINS).includes(contract.domain), `Domain ${contract.domain} must be recognized`);
      assert.ok(contract.schemaVersion, 'schemaVersion must be defined');
      assert.ok(Array.isArray(contract.supportedVersions) && contract.supportedVersions.length > 0);
      assert.ok(contract.supportedVersions.includes(contract.schemaVersion), 'supportedVersions must include current schemaVersion');

      // Producers
      assert.ok(Array.isArray(contract.producers) && contract.producers.length > 0, `${contract.eventType} must have at least 1 producer`);
      for (const prod of contract.producers) {
        assert.ok(prod.service, 'Producer must have a service name');
        assert.ok(prod.entrypoint, 'Producer must declare an entrypoint');
      }

      // Consumers
      assert.ok(Array.isArray(contract.consumers) && contract.consumers.length > 0, `${contract.eventType} must have at least 1 consumer`);
      for (const cons of contract.consumers) {
        assert.ok(cons.service, 'Consumer must have a service name');
        assert.ok(cons.handler, 'Consumer must declare a handler path');
        assert.equal(typeof cons.idempotent, 'boolean', 'Consumer must specify idempotent flag');
      }

      // Required fields & types
      assert.ok(Array.isArray(contract.requiredFields) && contract.requiredFields.length > 0);
      for (const field of contract.requiredFields) {
        assert.ok(contract.fieldTypes[field], `field '${field}' must have a declared type in fieldTypes`);
      }

      // Versioning rules & failure behaviors
      assert.ok(contract.versioningRules, 'Contract must define versioningRules');
      assert.ok(contract.allowedFailureBehavior, 'Contract must define allowedFailureBehavior');
      assert.ok(Object.values(FAILURE_STRATEGIES).includes(contract.allowedFailureBehavior.strategy));
    }
  });

  test('validates valid event payloads according to contract', () => {
    const validPurchase = {
      purchaseId: 'pur-101',
      materialId: 'mat-202',
      buyerAddress: 'GUSERBUYER',
      creatorAddress: 'GUSERCREATOR',
      amount: 15.5,
      currency: 'XLM',
      txHash: '0xabc123',
      settledAt: '2026-10-15T12:00:00Z',
    };

    const res = validateEventPayload('purchase.settled', validPurchase);
    assert.equal(res.valid, true);
    assert.equal(res.errors.length, 0);
  });

  test('rejects payload when required fields are missing', () => {
    const incompleteRefund = {
      refundId: 'ref-909',
      // purchaseId missing
      buyerAddress: 'GBUYER',
      creatorAddress: 'GCREATOR',
      amount: 10,
      currency: 'XLM',
      reason: 'Defective audio',
      processedAt: '2026-10-15T12:00:00Z',
    };

    const res = validateEventPayload('refund.processed', incompleteRefund);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.includes("Missing required field: 'purchaseId'")));
  });

  test('rejects payload when field type does not match contract', () => {
    const invalidTypePayout = {
      payoutId: 'pay-001',
      creatorAddress: 'GCREATOR',
      destinationAddress: 'GDEST',
      netAmount: 'one-hundred', // should be number
      feeAmount: 2,
      asset: 'XLM',
      txHash: '0xdef456',
      settledAt: '2026-10-15T12:00:00Z',
    };

    const res = validateEventPayload('payout.settled', invalidTypePayout);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.includes("Invalid type for field 'netAmount': expected number, received string")));
  });

  test('rejects unsupported schema version', () => {
    const validRoleChange = {
      userId: 'usr-1',
      userAddress: 'GADMIN',
      previousRole: 'member',
      newRole: 'moderator',
      modifiedBy: 'super-admin',
      changedAt: '2026-10-15T12:00:00Z',
    };

    const res = validateEventPayload('user.role_changed', validRoleChange, { version: '9.9.9' });
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.includes('Unsupported schema version 9.9.9')));
  });

  test('rejects unregistered event type', () => {
    const res = validateEventPayload('unregistered.event', { foo: 'bar' });
    assert.equal(res.valid, false);
    assert.match(res.errors[0], /Unknown event type/);
  });

  test('provides comprehensive cross-service boundary matrix', () => {
    const summary = getCrossServiceBoundarySummary();
    assert.ok(summary.totalEvents >= 6);
    assert.ok(summary.producers['checkout-api'].includes('purchase.settled'));
    assert.ok(summary.producers['refund-api'].includes('refund.processed'));
    assert.ok(summary.consumers['entitlement-worker'].includes('purchase.settled'));
    assert.ok(summary.consumers['financial-audit-sink'].includes('refund.processed'));
    assert.ok(summary.consumers['financial-audit-sink'].includes('payout.settled'));
  });
});
