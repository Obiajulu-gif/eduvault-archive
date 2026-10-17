/**
 * Automated verification and tests for External Dependency Degradation Matrix — Issue #956
 *
 * Verifies:
 *   - Documented failure modes and criticality tiers across all dependencies
 *   - Fallback UX / API behavior (user-safe messages, HTTP status, client actions)
 *   - Zero credential or topology leakage in error envelopes
 *   - Automated health checks, circuit breaker transitions, and recovery
 *   - Multi-service partial failure and cascade mitigation
 */

import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';

import {
  SERVICE_STATE,
  FALLBACK_ACTION,
  getServiceState,
  reportServiceState,
  resetFallbackRegistry,
} from '../../src/lib/fallback.js';

import {
  DEPENDENCY_TIER,
  FAILURE_MODES,
  CLIENT_ACTION,
  DEGRADATION_MATRIX,
  getDegradationPolicy,
  createDegradedApiResponse,
  runDependencyCheck,
  runAllDependencyChecks,
  resetDegradationMatrix,
  executeWithDegradation,
  initializeDegradationRegistry,
} from '../../src/lib/degradationMatrix.js';

beforeEach(() => {
  resetFallbackRegistry();
  resetDegradationMatrix();
});

describe('Degradation Matrix — Dependency Definitions & Tiers (#956)', () => {
  test('all critical dependencies are registered in matrix', () => {
    const expected = ['stellar', 'mongodb', 'pinata', 'email', 'webhooks'];
    for (const dep of expected) {
      assert.ok(DEGRADATION_MATRIX[dep], `Expected dependency ${dep} to be present in matrix`);
      assert.ok(DEGRADATION_MATRIX[dep].failureModes.length > 0, `Expected failure modes for ${dep}`);
      assert.ok(DEGRADATION_MATRIX[dep].tier, `Expected tier for ${dep}`);
    }
  });

  test('enforces appropriate criticality tiers', () => {
    assert.equal(DEGRADATION_MATRIX.stellar.tier, DEPENDENCY_TIER.TIER_1_CRITICAL);
    assert.equal(DEGRADATION_MATRIX.mongodb.tier, DEPENDENCY_TIER.TIER_1_CRITICAL);
    assert.equal(DEGRADATION_MATRIX.pinata.tier, DEPENDENCY_TIER.TIER_2_ESSENTIAL);
    assert.equal(DEGRADATION_MATRIX.email.tier, DEPENDENCY_TIER.TIER_3_SUPPORTING);
    assert.equal(DEGRADATION_MATRIX.webhooks.tier, DEPENDENCY_TIER.TIER_3_SUPPORTING);
  });

  test('critical actions are correctly designated', () => {
    assert.ok(DEGRADATION_MATRIX.stellar.criticalActions.includes('purchase'));
    assert.ok(DEGRADATION_MATRIX.stellar.criticalActions.includes('payout'));
    assert.ok(DEGRADATION_MATRIX.stellar.criticalActions.includes('refund'));
    assert.ok(DEGRADATION_MATRIX.mongodb.criticalActions.includes('write_purchase'));
    assert.ok(DEGRADATION_MATRIX.pinata.criticalActions.includes('upload_material'));
    assert.equal(DEGRADATION_MATRIX.email.criticalActions.length, 0);
  });
});

describe('Degradation Matrix — Fallback UX and API Behavior (#956)', () => {
  test('Stellar purchase: blocked with 503 when Stellar is unavailable', () => {
    reportServiceState('stellar', SERVICE_STATE.UNAVAILABLE, 'horizon-timeout');
    const policy = getDegradationPolicy('stellar', 'purchase');
    assert.equal(policy.action, FALLBACK_ACTION.BLOCK);
    assert.equal(policy.httpStatus, 503);
    assert.equal(policy.clientAction, CLIENT_ACTION.DISABLE_BUTTON);
    assert.ok(policy.userMessage.includes('wallet has not been charged'));
  });

  test('Stellar purchase: allowed with backoff warning when degraded', () => {
    reportServiceState('stellar', SERVICE_STATE.DEGRADED, 'congestion');
    const policy = getDegradationPolicy('stellar', 'purchase');
    assert.equal(policy.action, FALLBACK_ACTION.ALLOW);
    assert.equal(policy.httpStatus, 200);
    assert.equal(policy.clientAction, CLIENT_ACTION.RETRY_WITH_BACKOFF);
  });

  test('Stellar payout: queued with 202 when degraded', () => {
    reportServiceState('stellar', SERVICE_STATE.DEGRADED);
    const policy = getDegradationPolicy('stellar', 'payout');
    assert.equal(policy.action, FALLBACK_ACTION.QUEUE);
    assert.equal(policy.httpStatus, 202);
    assert.equal(policy.clientAction, CLIENT_ACTION.AWAIT_ASYNC_COMPLETION);
    assert.ok(policy.userMessage.includes('queued'));
  });

  test('Stellar balance: degrades to cached balance when unavailable', () => {
    reportServiceState('stellar', SERVICE_STATE.UNAVAILABLE);
    const policy = getDegradationPolicy('stellar', 'balance_read');
    assert.equal(policy.action, FALLBACK_ACTION.DEGRADE);
    assert.equal(policy.httpStatus, 200);
    assert.equal(policy.clientAction, CLIENT_ACTION.USE_CACHED_CONTENT);
  });

  test('MongoDB write_purchase: blocked with 503 when primary is unavailable', () => {
    reportServiceState('mongodb', SERVICE_STATE.UNAVAILABLE, 'replica-election');
    const policy = getDegradationPolicy('mongodb', 'write_purchase');
    assert.equal(policy.action, FALLBACK_ACTION.BLOCK);
    assert.equal(policy.httpStatus, 503);
    assert.ok(policy.userMessage.includes('no funds were deducted'));
  });

  test('MongoDB read_catalog: degrades to cached snapshot when unavailable', () => {
    reportServiceState('mongodb', SERVICE_STATE.UNAVAILABLE);
    const policy = getDegradationPolicy('mongodb', 'read_catalog');
    assert.equal(policy.action, FALLBACK_ACTION.DEGRADE);
    assert.equal(policy.httpStatus, 200);
    assert.equal(policy.clientAction, CLIENT_ACTION.USE_CACHED_CONTENT);
  });

  test('Pinata download: routes to fallback replica when gateway degrades', () => {
    reportServiceState('pinata', SERVICE_STATE.DEGRADED, 'gateway-504');
    const policy = getDegradationPolicy('pinata', 'download_content');
    assert.equal(policy.action, FALLBACK_ACTION.DEGRADE);
    assert.equal(policy.httpStatus, 200);
    assert.equal(policy.clientAction, CLIENT_ACTION.FALLBACK_REPLICA);
    assert.ok(policy.userMessage.includes('fallback gateway'));
  });

  test('Pinata upload: queues to quarantine when degraded, blocks when unavailable', () => {
    reportServiceState('pinata', SERVICE_STATE.DEGRADED);
    const degradedPolicy = getDegradationPolicy('pinata', 'upload_material');
    assert.equal(degradedPolicy.action, FALLBACK_ACTION.QUEUE);
    assert.equal(degradedPolicy.httpStatus, 202);

    reportServiceState('pinata', SERVICE_STATE.UNAVAILABLE);
    const unavailPolicy = getDegradationPolicy('pinata', 'upload_material');
    assert.equal(unavailPolicy.action, FALLBACK_ACTION.BLOCK);
    assert.equal(unavailPolicy.httpStatus, 503);
  });

  test('Email send_receipt: always queues without blocking user checkout', () => {
    reportServiceState('email', SERVICE_STATE.UNAVAILABLE, 'smtp-refused');
    const policy = getDegradationPolicy('email', 'send_receipt');
    assert.equal(policy.action, FALLBACK_ACTION.QUEUE);
    assert.equal(policy.httpStatus, 200);
    assert.ok(policy.userMessage.includes('receipt has been queued') || policy.userMessage.includes('receipt will be sent'));
  });

  test('Webhooks dispatch: queues with 202 when degraded or unavailable', () => {
    reportServiceState('webhooks', SERVICE_STATE.UNAVAILABLE);
    const policy = getDegradationPolicy('webhooks', 'dispatch');
    assert.equal(policy.action, FALLBACK_ACTION.QUEUE);
    assert.equal(policy.httpStatus, 202);
  });
});

describe('Degradation Matrix — User-Safe Error Sanitization (#956)', () => {
  test('createDegradedApiResponse redacts database URIs and credentials', () => {
    reportServiceState('mongodb', SERVICE_STATE.UNAVAILABLE);
    const rawError = new Error('Connection failed to mongodb+srv://admin:SuperSecretPass123@cluster.eduvault.internal:27017/prod');
    const response = createDegradedApiResponse('mongodb', 'write_purchase', { rawError });

    assert.equal(response.status, 503);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.code, 'SERVICE_UNAVAILABLE');
    assert.ok(!JSON.stringify(response.body).includes('SuperSecretPass123'));
    assert.ok(!JSON.stringify(response.body).includes('cluster.eduvault.internal'));
    assert.ok(response.headers['X-EduVault-Degraded-Service'], 'mongodb');
  });

  test('createDegradedApiResponse redacts Stellar secret seeds', () => {
    reportServiceState('stellar', SERVICE_STATE.UNAVAILABLE);
    const rawError = new Error('Signing failed with key SBWV43QW76Z2YV4H3LIXC3YDFZX3W2VTR733D6B57J34X6H2G43DFGHJ');
    const response = createDegradedApiResponse('stellar', 'purchase', { rawError });

    assert.equal(response.status, 503);
    assert.ok(!JSON.stringify(response.body).includes('SBWV43QW76Z2YV4H3LIXC3YDFZX3W2VTR733D6B57J34X6H2G43DFGHJ'));
    assert.ok(response.body.userMessage.includes('wallet has not been charged'));
  });

  test('createDegradedApiResponse redacts JWT bearer tokens and Pinata keys', () => {
    reportServiceState('pinata', SERVICE_STATE.UNAVAILABLE);
    const rawError = new Error('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisToken');
    const response = createDegradedApiResponse('pinata', 'upload_material', { rawError });

    assert.equal(response.status, 503);
    assert.ok(!JSON.stringify(response.body).includes('doNotLeakThisToken'));
  });

  test('sets Retry-After header matching policy', () => {
    reportServiceState('stellar', SERVICE_STATE.UNAVAILABLE);
    const response = createDegradedApiResponse('stellar', 'purchase');
    assert.equal(response.headers['Retry-After'], '30');
    assert.equal(response.body.retryAfterSeconds, 30);
  });
});

describe('Degradation Matrix — Automated Health Checks & Circuit Breaker (#956)', () => {
  test('healthy probe confirms operational state', async () => {
    const probe = async () => ({ healthy: true, latencyMs: 45 });
    const result = await runDependencyCheck('stellar', probe);

    assert.equal(result.healthy, true);
    assert.equal(result.currentState, SERVICE_STATE.HEALTHY);
    assert.equal(result.consecutiveFailures, 0);
    assert.equal(result.consecutiveSuccesses, 1);
  });

  test('repeated probe failures transition state from healthy -> degraded -> unavailable', async () => {
    const failingProbe = async () => ({
      healthy: false,
      failureMode: FAILURE_MODES.STELLAR_RPC_TIMEOUT,
      error: 'Gateway timeout',
    });

    // 1st failure: below threshold, stays healthy
    await runDependencyCheck('stellar', failingProbe);
    assert.equal(getServiceState('stellar').state, SERVICE_STATE.HEALTHY);

    // 2nd failure: reaches failureThreshold (2), transitions to degraded
    await runDependencyCheck('stellar', failingProbe);
    assert.equal(getServiceState('stellar').state, SERVICE_STATE.DEGRADED);

    // 3rd failure
    await runDependencyCheck('stellar', failingProbe);

    // 4th failure: reaches failureThreshold * 2 (4), transitions to unavailable
    await runDependencyCheck('stellar', failingProbe);
    assert.equal(getServiceState('stellar').state, SERVICE_STATE.UNAVAILABLE);
  });

  test('recovery probe transitions unavailable service back to healthy', async () => {
    // Manually mark degraded
    reportServiceState('stellar', SERVICE_STATE.DEGRADED);

    const healthyProbe = async () => ({ healthy: true, latencyMs: 20 });

    // 1st success
    await runDependencyCheck('stellar', healthyProbe);
    // 2nd success: reaches recoveryThreshold (2), transitions to healthy
    await runDependencyCheck('stellar', healthyProbe);

    assert.equal(getServiceState('stellar').state, SERVICE_STATE.HEALTHY);
  });

  test('catches unhandled probe exception and records failure cleanly', async () => {
    const throwingProbe = async () => {
      throw new Error('Socket hangup during ping');
    };

    const res = await runDependencyCheck('mongodb', throwingProbe);
    assert.equal(res.healthy, false);
    assert.equal(res.failureMode, 'EXCEPTION_DURING_PROBE');
  });

  test('runAllDependencyChecks checks all dependencies', async () => {
    const results = await runAllDependencyChecks({
      stellar: async () => ({ healthy: true }),
      mongodb: async () => ({ healthy: true }),
      pinata: async () => ({ healthy: false, failureMode: FAILURE_MODES.PINATA_RATE_LIMIT_429 }),
    });

    assert.equal(results.stellar.healthy, true);
    assert.equal(results.mongodb.healthy, true);
    assert.equal(results.pinata.healthy, false);
    assert.equal(results.pinata.failureMode, FAILURE_MODES.PINATA_RATE_LIMIT_429);
  });
});

describe('Degradation Matrix — executeWithDegradation (#956)', () => {
  test('executes handler successfully when healthy', async () => {
    let executed = false;
    const res = await executeWithDegradation('stellar', 'balance_read', async () => {
      executed = true;
      return { balance: '500.0' };
    });

    assert.equal(executed, true);
    assert.equal(res.ok, true);
    assert.equal(res.result.balance, '500.0');
    assert.equal(res.degraded, false);
  });

  test('blocks handler execution when service is unavailable', async () => {
    reportServiceState('stellar', SERVICE_STATE.UNAVAILABLE);
    let executed = false;
    const res = await executeWithDegradation('stellar', 'purchase', async () => {
      executed = true;
      return { success: true };
    });

    assert.equal(executed, false);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'SERVICE_UNAVAILABLE');
    assert.ok(res.userMessage.includes('wallet has not been charged'));
  });

  test('executes onQueue callback when policy action is QUEUE', async () => {
    reportServiceState('email', SERVICE_STATE.UNAVAILABLE);
    let queued = false;
    const res = await executeWithDegradation(
      'email',
      'send_receipt',
      async () => 'should_not_run',
      {
        onQueue: async () => {
          queued = true;
        },
      }
    );

    assert.equal(queued, true);
    assert.equal(res.ok, true);
    assert.equal(res.code, 'REQUEST_QUEUED');
    assert.equal(res.queued, true);
  });

  test('catches handler error during degraded operation and returns safe response', async () => {
    reportServiceState('pinata', SERVICE_STATE.DEGRADED);
    const res = await executeWithDegradation('pinata', 'download_content', async () => {
      throw new Error('Connection timeout to https://gateway.pinata.cloud/ipfs/Qm123');
    });

    assert.equal(res.ok, true); // Policy for download_content in degraded is DEGRADE, which produces user-safe payload
    assert.equal(res.degraded, true);
    assert.ok(!JSON.stringify(res).includes('Qm123'));
  });
});

describe('Degradation Matrix — Multi-Service Cascading Scenarios (#956)', () => {
  test('isolated failure in Pinata does not block Stellar purchases or MongoDB writes', () => {
    reportServiceState('pinata', SERVICE_STATE.UNAVAILABLE);

    // Stellar purchase is still allowed
    const stellarPolicy = getDegradationPolicy('stellar', 'purchase');
    assert.equal(stellarPolicy.action, FALLBACK_ACTION.ALLOW);

    // MongoDB writes still allowed
    const mongoPolicy = getDegradationPolicy('mongodb', 'write_purchase');
    assert.equal(mongoPolicy.action, FALLBACK_ACTION.ALLOW);

    // Only Pinata uploads are blocked
    const pinataPolicy = getDegradationPolicy('pinata', 'upload_material');
    assert.equal(pinataPolicy.action, FALLBACK_ACTION.BLOCK);
  });

  test('simultaneous Stellar and MongoDB failure protects user and maintains consistent state', () => {
    reportServiceState('stellar', SERVICE_STATE.UNAVAILABLE);
    reportServiceState('mongodb', SERVICE_STATE.UNAVAILABLE);

    const stellarRes = createDegradedApiResponse('stellar', 'purchase');
    const mongoRes = createDegradedApiResponse('mongodb', 'write_purchase');

    assert.equal(stellarRes.status, 503);
    assert.equal(mongoRes.status, 503);
    assert.ok(stellarRes.body.userMessage.includes('wallet has not been charged'));
    assert.ok(mongoRes.body.userMessage.includes('no funds were deducted'));
  });
});
