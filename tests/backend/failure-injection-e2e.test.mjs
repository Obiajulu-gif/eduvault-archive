/**
 * tests/backend/failure-injection-e2e.test.mjs
 *
 * End-to-end failure-injection verification for critical workflows (issue
 * #1098). Covers normal, failure, retry, and authorization paths as well as
 * compensation/rollback, opt-in safety, and dry-run planning.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  CRITICAL_WORKFLOW,
  FAULT_TYPE,
  INJECTION_STATUS,
  FailureInjectionAuthError,
  FailureInjectionValidationError,
  FailureInjectionBlockedError,
  assertInjectionAllowed,
  verifyOptInToken,
  createFailureInjectionRunner,
} from '../../src/lib/resilience/failureInjection.js';

const PRINCIPAL = { id: 'operator-1', role: 'operator' };
const SAFE_ENV = { NODE_ENV: 'test', FAILURE_INJECTION_ENABLED: 'true', FAILURE_INJECTION_TOKEN: 's3cr3t-token' };

function makeRunner(overrides = {}) {
  return createFailureInjectionRunner({
    authorize: async () => true,
    env: SAFE_ENV,
    sleep: async () => {},
    now: () => 1_000,
    ...overrides,
  });
}

// ─── Normal path ──────────────────────────────────────────────────────────

describe('failure injection — normal path (#1098)', () => {
  it('executes every step of a critical workflow with no fault', async () => {
    const runner = makeRunner();
    const result = await runner.run({
      workflowId: CRITICAL_WORKFLOW.PURCHASE,
      principal: PRINCIPAL,
      dryRun: false,
      optInToken: 's3cr3t-token',
    });

    assert.equal(result.status, INJECTION_STATUS.COMPLETED);
    assert.deepEqual(result.steps.map((s) => s.outcome), ['succeeded', 'succeeded', 'succeeded']);
    assert.deepEqual(result.effects, [
      'reservation:created',
      'payment:settled',
      'entitlement:granted',
    ]);
    assert.equal(result.compensation.length, 0);
    assert.equal(result.retryCount, 0);
    assert.equal(runner.getStats().completed, 1);
  });

  it('plans without executing when dryRun is true (the default)', async () => {
    let executed = 0;
    const runner = makeRunner();
    const result = await runner.run({ workflowId: CRITICAL_WORKFLOW.PAYOUT, principal: PRINCIPAL });

    assert.equal(result.status, INJECTION_STATUS.PLANNED);
    assert.equal(result.dryRun, true);
    assert.equal(result.effects.length, 0);
    assert.equal(executed, 0);
    assert.equal(result.plan.length, 3);
    assert.equal(result.plan[0].compensation, 'reverse-order');
    assert.equal(runner.getStats().planned, 1);
  });

  it('marks the injected step in the plan', () => {
    const runner = makeRunner();
    const result = runner.run({
      workflowId: CRITICAL_WORKFLOW.PURCHASE,
      fault: { type: FAULT_TYPE.DEPENDENCY_ERROR, step: 'settle_payment' },
      principal: PRINCIPAL,
    });
    // run() is async but the dry-run branch resolves synchronously enough for
    // the returned promise to be awaited below; keep the assertion simple.
    return result.then((plan) => {
      assert.deepEqual(plan.plan.map((step) => step.willInject), [null, 'DEPENDENCY_ERROR', null]);
    });
  });

  it('exposes the allowlisted workflow catalog', () => {
    const runner = makeRunner();
    const workflows = runner.getWorkflows();
    assert.deepEqual(workflows.map((w) => w.id), Object.values(CRITICAL_WORKFLOW));
    assert.equal(workflows.every((w) => w.steps.length > 0), true);
  });
});

// ─── Failure / rollback path ──────────────────────────────────────────────

describe('failure injection — failure and rollback path (#1098)', () => {
  it('compensates committed steps in reverse order after a dependency error', async () => {
    const runner = makeRunner();
    const result = await runner.run({
      workflowId: CRITICAL_WORKFLOW.PURCHASE,
      fault: { type: FAULT_TYPE.DEPENDENCY_ERROR, step: 'settle_payment', persistent: true },
      principal: PRINCIPAL,
      dryRun: false,
      optInToken: 's3cr3t-token',
    });

    assert.equal(result.status, INJECTION_STATUS.ROLLED_BACK);
    assert.equal(result.failure.step, 'settle_payment');
    // The first step committed, so it is compensated; the failing step never ran.
    assert.deepEqual(result.compensation, [{ step: 'reserve_material', outcome: 'compensated' }]);
    assert.deepEqual(result.rollbackEffects, ['compensated:reserve_material']);
    assert.equal(result.effects.includes('payment:settled'), false);
  });

  it('treats PARTIAL_WRITE as a durable side effect and compensates that step', async () => {
    const runner = makeRunner();
    const result = await runner.run({
      workflowId: CRITICAL_WORKFLOW.PURCHASE,
      fault: { type: FAULT_TYPE.PARTIAL_WRITE, step: 'settle_payment' },
      principal: PRINCIPAL,
      dryRun: false,
      optInToken: 's3cr3t-token',
    });

    assert.equal(result.status, INJECTION_STATUS.ROLLED_BACK);
    assert.equal(result.failure.partialWriteCommitted, true);
    assert.equal(result.effects.filter((e) => e === 'payment:settled').length, 1, 'partial write must not be replayed');
    assert.deepEqual(result.compensation.map((c) => c.step), ['settle_payment', 'reserve_material']);
    assert.equal(result.retryCount, 0);
  });

  it('does not retry an injected AUTH_DENIED failure', async () => {
    const runner = makeRunner();
    const result = await runner.run({
      workflowId: CRITICAL_WORKFLOW.PAYOUT,
      fault: { type: FAULT_TYPE.AUTH_DENIED, step: 'submit_transfer' },
      principal: PRINCIPAL,
      dryRun: false,
      optInToken: 's3cr3t-token',
    });

    assert.equal(result.status, INJECTION_STATUS.ROLLED_BACK);
    assert.equal(result.failure.permanent, true);
    assert.equal(result.failure.retryable, false);
    assert.equal(result.retryCount, 0);
    assert.deepEqual(result.compensation.map((c) => c.step), ['lock_funds']);
  });

  it('records a failed compensation without losing the trace', async () => {
    const runner = makeRunner();
    runner.registerWorkflow({
      id: CRITICAL_WORKFLOW.NOTIFICATION,
      steps: [
        {
          name: 'render_template',
          execute: async (ctx) => { ctx.recordEffect('rendered'); return { ok: true }; },
          compensate: async () => { throw new Error('compensation unavailable'); },
        },
        {
          name: 'send_email',
          execute: async () => ({}),
          compensate: async () => {},
        },
      ],
    });

    const result = await runner.run({
      workflowId: CRITICAL_WORKFLOW.NOTIFICATION,
      fault: { type: FAULT_TYPE.DEPENDENCY_ERROR, step: 'send_email', persistent: true },
      principal: PRINCIPAL,
      dryRun: false,
      optInToken: 's3cr3t-token',
    });

    assert.equal(result.status, INJECTION_STATUS.ROLLED_BACK);
    assert.equal(result.compensation[0].outcome, 'compensation_failed');
    assert.match(result.compensation[0].error, /compensation unavailable/);
    assert.deepEqual(result.effects, ['rendered']);
  });
});

// ─── Retry path ───────────────────────────────────────────────────────────

describe('failure injection — retry path (#1098)', () => {
  it('one-shot transient faults recover on the next attempt', async () => {
    const delays = [];
    const runner = makeRunner({ sleep: async (ms) => { delays.push(ms); } });
    const result = await runner.run({
      workflowId: CRITICAL_WORKFLOW.ENTITLEMENT_GRANT,
      fault: { type: FAULT_TYPE.RATE_LIMIT, step: 'write_entitlement' },
      principal: PRINCIPAL,
      dryRun: false,
      optInToken: 's3cr3t-token',
    });

    assert.equal(result.status, INJECTION_STATUS.COMPLETED);
    assert.equal(result.retryCount, 1);
    assert.deepEqual(delays, [10]);
    assert.equal(result.steps[1].attempts, 2);
    assert.deepEqual(result.effects, ['purchase:verified', 'entitlement:written', 'notification:queued']);
    assert.equal(result.compensation.length, 0);
  });

  it('persistent transient faults exhaust retries then roll back', async () => {
    const runner = makeRunner();
    const result = await runner.run({
      workflowId: CRITICAL_WORKFLOW.ENTITLEMENT_GRANT,
      fault: { type: FAULT_TYPE.DEPENDENCY_TIMEOUT, step: 'write_entitlement', persistent: true },
      principal: PRINCIPAL,
      dryRun: false,
      optInToken: 's3cr3t-token',
    });

    assert.equal(result.status, INJECTION_STATUS.ROLLED_BACK);
    assert.equal(result.retryCount, 2);
    assert.equal(result.steps[1].attempts, 3);
    assert.deepEqual(result.compensation.map((c) => c.step), ['verify_purchase']);
  });

  it('emits structured retry events', () => {
    const events = [];
    const runner = makeRunner({ onEvent: (event) => events.push(event) });
    return runner.run({
      workflowId: CRITICAL_WORKFLOW.ENTITLEMENT_GRANT,
      fault: { type: FAULT_TYPE.CACHE_UNAVAILABLE, step: 'verify_purchase' },
      principal: PRINCIPAL,
      dryRun: false,
      optInToken: 's3cr3t-token',
    }).then(() => {
      assert.equal(events.filter((e) => e.kind === 'RETRY').length, 1);
      assert.equal(events.at(-1).kind, INJECTION_STATUS.COMPLETED);
    });
  });
});

// ─── Authorization / safety path ──────────────────────────────────────────

describe('failure injection — authorization and safety path (#1098)', () => {
  it('rejects unauthorized callers before any step runs', async () => {
    const runner = makeRunner({ authorize: async () => false });
    await assert.rejects(
      () => runner.run({ workflowId: CRITICAL_WORKFLOW.PURCHASE, principal: { id: 'u', role: 'learner' }, dryRun: false }),
      FailureInjectionAuthError,
    );
    assert.equal(runner.getStats().rejected, 1);
    assert.equal(runner.getStats().completed, 0);
  });

  it('treats a throwing authorize hook as a denial', async () => {
    const runner = makeRunner({ authorize: async () => { throw new Error('auth down'); } });
    await assert.rejects(
      () => runner.run({ workflowId: CRITICAL_WORKFLOW.PURCHASE, principal: PRINCIPAL }),
      FailureInjectionAuthError,
    );
  });

  it('blocks real execution without the opt-in token', async () => {
    const runner = makeRunner();
    await assert.rejects(
      () => runner.run({ workflowId: CRITICAL_WORKFLOW.PURCHASE, principal: PRINCIPAL, dryRun: false, optInToken: 'wrong' }),
      FailureInjectionBlockedError,
    );
    assert.equal(runner.getStats().blocked, 1);
  });

  it('blocks real execution in production', async () => {
    const runner = makeRunner({ env: { ...SAFE_ENV, NODE_ENV: 'production' } });
    await assert.rejects(
      () => runner.run({ workflowId: CRITICAL_WORKFLOW.PURCHASE, principal: PRINCIPAL, dryRun: false, optInToken: 's3cr3t-token' }),
      (error) => error instanceof FailureInjectionBlockedError && /production/.test(error.message),
    );
  });

  it('allows a dry run without any environment opt-in', async () => {
    const runner = makeRunner({ env: { NODE_ENV: 'test' } });
    const result = await runner.run({ workflowId: CRITICAL_WORKFLOW.PURCHASE, principal: PRINCIPAL });
    assert.equal(result.status, INJECTION_STATUS.PLANNED);
  });

  it('verifies opt-in tokens in constant time and rejects missing values', () => {
    assert.equal(verifyOptInToken({ provided: 's3cr3t-token', configured: 's3cr3t-token' }), true);
    assert.equal(verifyOptInToken({ provided: 'wrong', configured: 's3cr3t-token' }), false);
    assert.equal(verifyOptInToken({ provided: '', configured: '' }), false);
    assert.equal(verifyOptInToken({}), false);
    assert.throws(
      () => assertInjectionAllowed({ env: SAFE_ENV, optInToken: 'wrong' }),
      FailureInjectionBlockedError,
    );
  });

  it('validates workflow and fault configuration', async () => {
    const runner = makeRunner();
    await assert.rejects(() => runner.run({ workflowId: 'unknown', principal: PRINCIPAL }), FailureInjectionValidationError);
    await assert.rejects(
      () => runner.run({ workflowId: CRITICAL_WORKFLOW.PURCHASE, fault: { type: 'NOPE', step: 'x' }, principal: PRINCIPAL }),
      FailureInjectionValidationError,
    );
    await assert.rejects(
      () => runner.run({ workflowId: CRITICAL_WORKFLOW.PURCHASE, fault: { type: FAULT_TYPE.DEPENDENCY_ERROR, step: 'missing' }, principal: PRINCIPAL }),
      FailureInjectionValidationError,
    );
    assert.throws(() => runner.registerWorkflow({ id: 'not-allowlisted', steps: [] }), FailureInjectionValidationError);
    assert.throws(() => createFailureInjectionRunner({ maxAttempts: 0 }), FailureInjectionValidationError);
  });

  it('resets stats and restores built-in workflows', () => {
    const runner = makeRunner();
    runner.registerWorkflow({
      id: CRITICAL_WORKFLOW.PAYOUT,
      steps: [{ name: 'only', execute: async () => ({}), compensate: async () => {} }],
    });
    assert.equal(runner.getWorkflows().find((w) => w.id === CRITICAL_WORKFLOW.PAYOUT).steps.length, 1);
    runner.reset();
    assert.equal(runner.getWorkflows().find((w) => w.id === CRITICAL_WORKFLOW.PAYOUT).steps.length, 3);
    assert.deepEqual(runner.getStats().completed, 0);
  });
});
