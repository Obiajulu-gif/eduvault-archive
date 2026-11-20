import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  detectEventDrift,
  detectBatchDrift,
  detectContractEvolutionDrift,
  reconcileSchemaDrift,
  DRIFT_SEVERITY,
  DRIFT_TYPES,
  DriftAuthorizationError,
  DriftValidationError,
} from '../../src/lib/backend/eventSchemaDriftDetector.js';

describe('Cross-Service Event Schema Drift Detection (#1107)', () => {
  const validPurchasePayload = {
    purchaseId: 'pur-101',
    materialId: 'mat-202',
    buyerAddress: 'GBUYER0001',
    creatorAddress: 'GCREATOR0001',
    amount: 25.5,
    currency: 'XLM',
    txHash: '0xabc123789',
    settledAt: '2026-11-19T06:00:00Z',
  };

  test('normal path: detects NO_DRIFT when event strictly conforms to contract', () => {
    const event = {
      eventType: 'purchase.settled',
      producerService: 'checkout-api',
      schemaVersion: '1.2.0',
      payload: { ...validPurchasePayload },
    };

    const result = detectEventDrift(event);
    assert.equal(result.drifted, false);
    assert.equal(result.severity, DRIFT_SEVERITY.NONE);
    assert.ok(result.driftTypes.includes(DRIFT_TYPES.NO_DRIFT));
    assert.equal(result.violations.length, 0);
    assert.equal(result.incompatibleConsumers.length, 0);
  });

  test('failure path: detects UNKNOWN_EVENT when event type is not in registry', () => {
    const event = {
      eventType: 'unknown.nonexistent.event',
      producerService: 'some-service',
      payload: { foo: 'bar' },
    };

    const result = detectEventDrift(event);
    assert.equal(result.drifted, true);
    assert.equal(result.severity, DRIFT_SEVERITY.CRITICAL);
    assert.ok(result.driftTypes.includes(DRIFT_TYPES.UNKNOWN_EVENT));
  });

  test('failure path: detects MISSING_REQUIRED_FIELD with critical severity', () => {
    const badPayload = { ...validPurchasePayload };
    delete badPayload.txHash; // required field missing

    const event = {
      eventType: 'purchase.settled',
      producerService: 'checkout-api',
      payload: badPayload,
    };

    const result = detectEventDrift(event);
    assert.equal(result.drifted, true);
    assert.equal(result.severity, DRIFT_SEVERITY.CRITICAL);
    assert.ok(result.driftTypes.includes(DRIFT_TYPES.MISSING_REQUIRED_FIELD));
    assert.ok(result.violations.some((v) => v.includes('Missing required field: "txHash"')));
  });

  test('failure path: detects TYPE_MISMATCH when field has incorrect type', () => {
    const badPayload = {
      ...validPurchasePayload,
      amount: 'twenty-five', // should be number
    };

    const event = {
      eventType: 'purchase.settled',
      producerService: 'checkout-api',
      payload: badPayload,
    };

    const result = detectEventDrift(event);
    assert.equal(result.drifted, true);
    assert.equal(result.severity, DRIFT_SEVERITY.CRITICAL);
    assert.ok(result.driftTypes.includes(DRIFT_TYPES.TYPE_MISMATCH));
    assert.ok(result.violations.some((v) => v.includes('expected number, received string')));
  });

  test('failure path: detects UNSUPPORTED_VERSION when schemaVersion is invalid', () => {
    const event = {
      eventType: 'purchase.settled',
      producerService: 'checkout-api',
      schemaVersion: '9.9.9', // unsupported version
      payload: { ...validPurchasePayload },
    };

    const result = detectEventDrift(event);
    assert.equal(result.drifted, true);
    assert.equal(result.severity, DRIFT_SEVERITY.CRITICAL);
    assert.ok(result.driftTypes.includes(DRIFT_TYPES.UNSUPPORTED_VERSION));
  });

  test('authorization path: detects PRODUCER_UNAUTHORIZED when unregistered service emits', () => {
    const event = {
      eventType: 'purchase.settled',
      producerService: 'rogue-external-worker', // not checkout-api
      payload: { ...validPurchasePayload },
    };

    const result = detectEventDrift(event);
    assert.equal(result.drifted, true);
    assert.equal(result.severity, DRIFT_SEVERITY.CRITICAL);
    assert.ok(result.driftTypes.includes(DRIFT_TYPES.PRODUCER_UNAUTHORIZED));
  });

  test('additive path: classifies extra fields as non-breaking ADDITIVE_FIELD with warning', () => {
    const additivePayload = {
      ...validPurchasePayload,
      experimentalCouponTrackingId: 'coup-777',
      campaignSource: 'partner_promo',
    };

    const event = {
      eventType: 'purchase.settled',
      producerService: 'checkout-api',
      payload: additivePayload,
    };

    const result = detectEventDrift(event, { allowAdditive: true });
    assert.equal(result.drifted, true);
    assert.equal(result.severity, DRIFT_SEVERITY.WARNING);
    assert.ok(result.driftTypes.includes(DRIFT_TYPES.ADDITIVE_FIELD));
    assert.deepEqual(result.additiveFields, ['experimentalCouponTrackingId', 'campaignSource']);
  });

  test('additive path (strict mode): rejects extra fields when allowAdditive=false', () => {
    const additivePayload = {
      ...validPurchasePayload,
      unexpectedMetadata: 123,
    };

    const event = {
      eventType: 'purchase.settled',
      producerService: 'checkout-api',
      payload: additivePayload,
    };

    const result = detectEventDrift(event, { allowAdditive: false });
    assert.equal(result.drifted, true);
    assert.equal(result.severity, DRIFT_SEVERITY.CRITICAL);
    assert.ok(result.violations.some((v) => v.includes('Undeclared additive fields present in strict mode')));
  });

  test('consumer incompatibility: lists all downstream consumers impacted by breaking drift', () => {
    const brokenEvent = {
      eventType: 'purchase.settled',
      producerService: 'checkout-api',
      payload: { invalid: true }, // missing all required fields
    };

    const result = detectEventDrift(brokenEvent);
    assert.equal(result.drifted, true);
    assert.ok(result.driftTypes.includes(DRIFT_TYPES.CONSUMER_INCOMPATIBLE));
    assert.ok(result.incompatibleConsumers.length >= 4); // entitlement-worker, payout-accrual-worker, etc.
  });

  test('batch processing: aggregates statistics across multiple events and identifies anomalies', () => {
    const events = [
      { eventType: 'purchase.settled', producerService: 'checkout-api', payload: { ...validPurchasePayload } },
      { eventType: 'purchase.settled', producerService: 'checkout-api', payload: { ...validPurchasePayload, extra: 'bonus' } },
      { eventType: 'purchase.settled', producerService: 'checkout-api', payload: { purchaseId: 'p1' } }, // breaking
    ];

    const batch = detectBatchDrift(events);
    assert.equal(batch.ok, false);
    assert.equal(batch.summary.totalEvents, 3);
    assert.equal(batch.summary.cleanEvents, 1);
    assert.equal(batch.summary.warningEvents, 1);
    assert.equal(batch.summary.criticalEvents, 1);
  });

  test('contract evolution: flags breaking changes (dropped fields, type changes, dropped versions)', () => {
    const base = {
      requiredFields: ['id', 'user', 'amount'],
      fieldTypes: { id: 'string', user: 'string', amount: 'number' },
      supportedVersions: ['1.0.0', '1.1.0'],
    };

    const candidate = {
      requiredFields: ['id', 'user', 'amount', 'newStrictField'], // breaking: new required field
      fieldTypes: { id: 'string', user: 'string', amount: 'string' }, // breaking: amount changed to string
      supportedVersions: ['1.1.0'], // breaking: 1.0.0 dropped
    };

    const evolution = detectContractEvolutionDrift(base, candidate);
    assert.equal(evolution.isBreaking, true);
    assert.equal(evolution.severity, DRIFT_SEVERITY.CRITICAL);
    assert.ok(evolution.breakingChanges.some((c) => c.includes('newStrictField')));
    assert.ok(evolution.breakingChanges.some((c) => c.includes('amount')));
    assert.ok(evolution.breakingChanges.some((c) => c.includes('1.0.0')));
  });

  test('reconciliation authorization path: rejects non-admin/non-operator actors', async () => {
    const unauthorizedActor = { id: 'u1', role: 'viewer' };
    await assert.rejects(
      () => reconcileSchemaDrift({
        event: { eventType: 'purchase.settled' },
        action: 'quarantine',
        actor: unauthorizedActor,
      }),
      DriftAuthorizationError
    );
  });

  test('reconciliation retry and audit path: records remediation for authorized operator', async () => {
    const authorizedActor = { id: 'admin-1', role: 'admin' };
    const fakeDb = {
      inserted: [],
      collection(name) {
        return {
          insertOne: async (doc) => { fakeDb.inserted.push({ collection: name, doc }); },
        };
      },
    };

    const record = await reconcileSchemaDrift({
      db: fakeDb,
      event: { eventType: 'purchase.settled' },
      action: 'retry',
      actor: authorizedActor,
      reason: 'Transient serialization repair',
    });

    assert.equal(record.action, 'retry');
    assert.equal(record.status, 'pending_retry');
    assert.equal(fakeDb.inserted.length, 1);
    assert.equal(fakeDb.inserted[0].collection, 'event_schema_drift_remediations');
  });
});

