/**
 * src/lib/resilience/failureInjection.js
 *
 * End-to-end failure injection for critical workflows — Issue #1098.
 *
 * A small, deterministic harness that runs a critical workflow end-to-end
 * while injecting a fault at one dependency boundary. It is intentionally a
 * *harness*: real workflow steps register their own execute/compensate hooks,
 * while the built-in simulated workflows only record effects in memory. The
 * harness never flips environment variables, signs transactions, or writes to
 * a database on its own.
 *
 * Guarantees:
 *   - Normal path: without a fault every step executes and records its effect.
 *   - Failure path: dependency faults fail the targeted step; committed steps
 *     are compensated in reverse order (deterministic rollback).
 *   - Retry path: transient faults are one-shot by default, so a retry reaches
 *     the next attempt and completes; `persistent: true` exhausts retries.
 *   - Authorization path: an authorize gate plus an explicit opt-in token must
 *     both pass before any step executes. Unauthorized calls never run steps.
 *   - Observability: every run returns a structured trace with per-step
 *     attempts, recorded effects, and compensation results.
 */

import { timingSafeEqual } from 'node:crypto';

// ─── Constants ─────────────────────────────────────────────────────────────

export const CRITICAL_WORKFLOW = Object.freeze({
  PURCHASE: 'purchase',
  ENTITLEMENT_GRANT: 'entitlement_grant',
  MATERIAL_UPLOAD: 'material_upload',
  PAYOUT: 'payout',
  NOTIFICATION: 'notification',
});

export const FAULT_TYPE = Object.freeze({
  DEPENDENCY_TIMEOUT: 'DEPENDENCY_TIMEOUT',
  DEPENDENCY_ERROR: 'DEPENDENCY_ERROR',
  PARTIAL_WRITE: 'PARTIAL_WRITE',
  AUTH_DENIED: 'AUTH_DENIED',
  RATE_LIMIT: 'RATE_LIMIT',
  CACHE_UNAVAILABLE: 'CACHE_UNAVAILABLE',
});

export const INJECTION_STATUS = Object.freeze({
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  ROLLED_BACK: 'ROLLED_BACK',
  BLOCKED: 'BLOCKED',
  PLANNED: 'PLANNED',
});

const TRANSIENT_FAULTS = new Set([
  FAULT_TYPE.DEPENDENCY_TIMEOUT,
  FAULT_TYPE.DEPENDENCY_ERROR,
  FAULT_TYPE.PARTIAL_WRITE,
  FAULT_TYPE.RATE_LIMIT,
  FAULT_TYPE.CACHE_UNAVAILABLE,
]);

// ─── Errors ────────────────────────────────────────────────────────────────

export class FailureInjectionAuthError extends Error {
  constructor(message = 'Not authorized to run failure injection.') {
    super(message);
    this.name = 'FailureInjectionAuthError';
    this.code = 'FAILURE_INJECTION_AUTH_FORBIDDEN';
    this.status = 403;
  }
}

export class FailureInjectionValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'FailureInjectionValidationError';
    this.code = 'FAILURE_INJECTION_VALIDATION_ERROR';
    this.status = 400;
    this.details = details;
  }
}

export class FailureInjectionBlockedError extends Error {
  constructor(message = 'Failure injection is not enabled in this environment.') {
    super(message);
    this.name = 'FailureInjectionBlockedError';
    this.code = 'FAILURE_INJECTION_BLOCKED';
    this.status = 409;
  }
}

// ─── Safety guards ─────────────────────────────────────────────────────────

/**
 * Constant-time comparison. Returns false when either side is missing so a
 * missing token can never be treated as a match.
 */
export function verifyOptInToken({ provided, configured } = {}) {
  if (typeof provided !== 'string' || !provided) return false;
  if (typeof configured !== 'string' || !configured) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(configured);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Production guard. Injection is opt-in only: it must be explicitly enabled
 * AND the caller must supply the configured token. This function never mutates
 * the environment.
 */
export function assertInjectionAllowed({
  env = process.env,
  optInToken,
  requireOptIn = true,
  allowInProduction = false,
} = {}) {
  if (!requireOptIn) return true;

  if (env.NODE_ENV === 'production' && !allowInProduction) {
    throw new FailureInjectionBlockedError('Failure injection is disabled in production. Use a staging environment.');
  }
  if (env.FAILURE_INJECTION_ENABLED !== 'true') {
    throw new FailureInjectionBlockedError('FAILURE_INJECTION_ENABLED must be "true" to inject faults.');
  }
  if (!verifyOptInToken({ provided: optInToken, configured: env.FAILURE_INJECTION_TOKEN })) {
    throw new FailureInjectionBlockedError('A valid failure-injection opt-in token is required.');
  }
  return true;
}

// ─── Built-in simulated workflows ─────────────────────────────────────────

/**
 * Simulated steps record effects only. They are safe for staging drills and
 * for the automated tests; a production service registers its real workflow
 * with `registerWorkflow` instead of using these.
 */
function simulatedStep(name, dependency, effect) {
  return {
    name,
    dependency,
    execute: async (ctx) => {
      ctx.recordEffect(effect);
      return { step: name, ok: true };
    },
    compensate: async (ctx) => {
      ctx.recordRollback(`compensated:${name}`);
    },
  };
}

export const SIMULATED_WORKFLOWS = Object.freeze({
  [CRITICAL_WORKFLOW.PURCHASE]: Object.freeze({
    id: CRITICAL_WORKFLOW.PURCHASE,
    critical: true,
    steps: [
      simulatedStep('reserve_material', 'database', 'reservation:created'),
      simulatedStep('settle_payment', 'stellar', 'payment:settled'),
      simulatedStep('grant_entitlement', 'entitlements', 'entitlement:granted'),
    ],
  }),
  [CRITICAL_WORKFLOW.ENTITLEMENT_GRANT]: Object.freeze({
    id: CRITICAL_WORKFLOW.ENTITLEMENT_GRANT,
    critical: true,
    steps: [
      simulatedStep('verify_purchase', 'database', 'purchase:verified'),
      simulatedStep('write_entitlement', 'entitlements', 'entitlement:written'),
      simulatedStep('notify_buyer', 'email', 'notification:queued'),
    ],
  }),
  [CRITICAL_WORKFLOW.MATERIAL_UPLOAD]: Object.freeze({
    id: CRITICAL_WORKFLOW.MATERIAL_UPLOAD,
    critical: false,
    steps: [
      simulatedStep('store_blob', 'storage', 'blob:stored'),
      simulatedStep('pin_metadata', 'ipfs', 'metadata:pinned'),
      simulatedStep('index_material', 'indexer', 'material:indexed'),
    ],
  }),
  [CRITICAL_WORKFLOW.PAYOUT]: Object.freeze({
    id: CRITICAL_WORKFLOW.PAYOUT,
    critical: true,
    steps: [
      simulatedStep('lock_funds', 'database', 'funds:locked'),
      simulatedStep('submit_transfer', 'stellar', 'transfer:submitted'),
      simulatedStep('mark_paid', 'database', 'payout:marked'),
    ],
  }),
  [CRITICAL_WORKFLOW.NOTIFICATION]: Object.freeze({
    id: CRITICAL_WORKFLOW.NOTIFICATION,
    critical: false,
    steps: [
      simulatedStep('render_template', 'database', 'template:rendered'),
      simulatedStep('send_email', 'email', 'email:sent'),
    ],
  }),
});

// ─── Runner ────────────────────────────────────────────────────────────────

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {Function} [options.authorize]        async (principal, { workflowId, fault }) => boolean
 * @param {boolean} [options.requireOptIn=true] Require token/environment gate.
 * @param {object} [options.env=process.env]    Environment used by the gate.
 * @param {number} [options.maxAttempts=3]      Attempts per step.
 * @param {number} [options.retryDelayMs=10]    Base back-off delay.
 * @param {Function} [options.sleep]            Injectable delay.
 * @param {Function} [options.now]              Injectable clock.
 * @param {Function} [options.onEvent]          (event) => void observability hook.
 */
export function createFailureInjectionRunner({
  authorize = async () => false,
  requireOptIn = true,
  env = process.env,
  maxAttempts = 3,
  retryDelayMs = 10,
  sleep = defaultSleep,
  now = () => Date.now(),
  onEvent = () => {},
} = {}) {
  if (typeof authorize !== 'function') {
    throw new FailureInjectionValidationError('authorize must be a function.');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new FailureInjectionValidationError('maxAttempts must be a positive integer.');
  }

  const workflows = new Map(
    Object.entries(SIMULATED_WORKFLOWS).map(([id, definition]) => [id, { ...definition, steps: [...definition.steps] }]),
  );

  const stats = {
    planned: 0,
    completed: 0,
    failed: 0,
    rolledBack: 0,
    blocked: 0,
    rejected: 0,
    retries: 0,
    injectedFaults: 0,
  };

  function emit(event) {
    onEvent({ at: now(), ...event });
  }

  function registerWorkflow(definition) {
    if (!definition || typeof definition.id !== 'string' || !definition.id) {
      throw new FailureInjectionValidationError('Workflow definition requires an id.');
    }
    if (!Object.values(CRITICAL_WORKFLOW).includes(definition.id)) {
      throw new FailureInjectionValidationError(`Workflow "${definition.id}" is not an allowlisted critical workflow.`);
    }
    if (!Array.isArray(definition.steps) || definition.steps.length === 0) {
      throw new FailureInjectionValidationError('Workflow must contain at least one step.');
    }
    for (const step of definition.steps) {
      if (!step?.name || typeof step.execute !== 'function' || typeof step.compensate !== 'function') {
        throw new FailureInjectionValidationError('Every step requires name, execute and compensate functions.');
      }
    }
    workflows.set(definition.id, { ...definition, steps: [...definition.steps] });
    return true;
  }

  function getWorkflows() {
    return [...workflows.values()].map((definition) => ({
      id: definition.id,
      critical: Boolean(definition.critical),
      steps: definition.steps.map((step) => ({ name: step.name, dependency: step.dependency ?? null })),
    }));
  }

  function validateFault(workflow, fault) {
    if (fault === null || fault === undefined) return null;
    if (typeof fault !== 'object' || !FAULT_TYPE[fault.type]) {
      throw new FailureInjectionValidationError('fault.type must be a supported fault type.');
    }
    if (!fault.step) {
      throw new FailureInjectionValidationError('fault.step is required.');
    }
    if (!workflow.steps.some((step) => step.name === fault.step)) {
      throw new FailureInjectionValidationError(`Step "${fault.step}" does not exist in workflow "${workflow.id}".`);
    }
    return {
      type: fault.type,
      step: fault.step,
      persistent: fault.persistent === true,
      transient: TRANSIENT_FAULTS.has(fault.type),
    };
  }

  /** Deterministic, side-effect-free description of a planned run. */
  function buildPlan(workflow, fault) {
    return workflow.steps.map((step) => ({
      name: step.name,
      dependency: step.dependency ?? null,
      willInject: fault?.step === step.name ? fault.type : null,
      compensation: typeof step.compensate === 'function' ? 'reverse-order' : 'none',
    }));
  }

  /**
   * Run a workflow end-to-end with an optional injected fault.
   *
   * @param {object} options
   * @param {string} options.workflowId
   * @param {object} [options.fault]           { type, step, persistent? }
   * @param {object} [options.principal]       Passed to the authorize gate.
   * @param {string} [options.correlationId]   Trace id.
   * @param {boolean} [options.dryRun=true]    When true, no step executes.
   * @param {string} [options.optInToken]      Required when opt-in is enforced.
   * @param {boolean} [options.allowInProduction=false]
   */
  async function run({
    workflowId,
    fault: rawFault = null,
    principal = null,
    correlationId = `corr-${now()}`,
    dryRun = true,
    optInToken,
    allowInProduction = false,
  } = {}) {
    const workflow = workflows.get(workflowId);
    if (!workflow) {
      throw new FailureInjectionValidationError(`Unknown workflow "${workflowId}".`);
    }

    // Authorization runs first — before planning, opt-in checks, or any step.
    let allowed;
    try {
      allowed = await authorize(principal, { workflowId, fault: rawFault, dryRun });
    } catch {
      allowed = false;
    }
    if (allowed !== true) {
      stats.rejected += 1;
      emit({ kind: 'AUTH_REJECTED', workflowId, correlationId });
      throw new FailureInjectionAuthError();
    }

    const fault = validateFault(workflow, rawFault);

    // The opt-in gate is only required for real execution; planning is read-only.
    if (!dryRun) {
      try {
        assertInjectionAllowed({ env, optInToken, requireOptIn, allowInProduction });
      } catch (error) {
        stats.blocked += 1;
        emit({ kind: 'BLOCKED', workflowId, correlationId, reason: error.message });
        throw error;
      }
    }

    const plan = buildPlan(workflow, fault);
    const startedAt = now();

    if (dryRun) {
      stats.planned += 1;
      emit({ kind: 'PLANNED', workflowId, correlationId });
      return {
        workflowId,
        correlationId,
        dryRun: true,
        status: INJECTION_STATUS.PLANNED,
        fault,
        plan,
        steps: [],
        effects: [],
        compensation: [],
        retryCount: 0,
        startedAt,
        finishedAt: now(),
      };
    }

    if (fault) stats.injectedFaults += 1;

    const context = {
      correlationId,
      workflowId,
      effects: [],
      rollbacks: [],
      recordEffect: (effect) => { context.effects.push(effect); },
      recordRollback: (entry) => { context.rollbacks.push(entry); },
    };

    const traces = [];
    const completed = [];
    let retryCount = 0;
    let failure = null;
    let faultConsumed = false;

    for (const step of workflow.steps) {
      const target = fault?.step === step.name;
      const injectHere = target && (fault.persistent || !faultConsumed);
      // A non-transient fault or a committed partial write must not be
      // replayed: replaying a partial write would duplicate the side effect.
      const noReplay = injectHere && (!fault.transient || fault.type === FAULT_TYPE.PARTIAL_WRITE);
      const attemptsForStep = noReplay ? 1 : maxAttempts;

      let stepOutcome = null;

      for (let attempt = 1; attempt <= attemptsForStep; attempt += 1) {
        try {
          const shouldInject = injectHere && (fault.persistent || !faultConsumed);

          if (shouldInject) {
            faultConsumed = true;
            if (fault.type === FAULT_TYPE.AUTH_DENIED) {
              const error = new Error('Injected authorization denial at dependency boundary.');
              error.retryable = false;
              error.injected = true;
              throw error;
            }
            // All other faults fail BEFORE the step's side effect, except
            // PARTIAL_WRITE, which commits first and then fails.
            if (fault.type !== FAULT_TYPE.PARTIAL_WRITE) {
              const error = new Error(`Injected ${fault.type} at ${step.name}.`);
              error.retryable = fault.transient;
              error.injected = true;
              throw error;
            }
          }

          const result = await step.execute(context);

          if (shouldInject && fault.type === FAULT_TYPE.PARTIAL_WRITE) {
            // The side effect is already durable — record it so the rollback
            // pass compensates this exact step instead of replaying it.
            completed.push({ step, result: result ?? null });
            const error = new Error('Injected PARTIAL_WRITE: side effect committed before failure.');
            error.retryable = true;
            error.injected = true;
            error.partialWriteCommitted = true;
            throw error;
          }

          stepOutcome = { step: step.name, attempts: attempt, outcome: 'succeeded', result: result ?? null };
          completed.push({ step, result: result ?? null });
          break;
        } catch (error) {
          if (attempt >= attemptsForStep || error.retryable === false) {
            failure = {
              step: step.name,
              faultType: fault?.type ?? null,
              message: error.message,
              retryable: error.retryable !== false,
              permanent: error.retryable === false,
              partialWriteCommitted: error.partialWriteCommitted === true,
            };
            stepOutcome = { step: step.name, attempts: attempt, outcome: 'failed', error: error.message };
          } else {
            retryCount += 1;
            stats.retries += 1;
            emit({ kind: 'RETRY', workflowId, correlationId, step: step.name, attempt: attempt + 1 });
            await sleep(retryDelayMs * 2 ** (attempt - 1));
          }
        }
      }

      traces.push(stepOutcome);
      if (failure) break;
    }

    const effects = [...context.effects];
    let status = failure ? INJECTION_STATUS.FAILED : INJECTION_STATUS.COMPLETED;

    // Rollback compensates every committed step in reverse order, including a
    // step whose PARTIAL_WRITE reported a failure after committing.
    const compensation = [];
    if (failure && completed.length > 0) {
      for (const item of [...completed].reverse()) {
        try {
          await item.step.compensate(context, item.result);
          compensation.push({ step: item.step.name, outcome: 'compensated' });
        } catch (error) {
          compensation.push({ step: item.step.name, outcome: 'compensation_failed', error: error.message });
        }
      }
      status = INJECTION_STATUS.ROLLED_BACK;
      stats.rolledBack += 1;
    }

    if (failure) stats.failed += 1;
    else stats.completed += 1;

    emit({ kind: status, workflowId, correlationId, faultType: fault?.type ?? null });

    return {
      workflowId,
      correlationId,
      dryRun: false,
      status,
      fault,
      plan,
      steps: traces,
      effects,
      rollbackEffects: [...context.rollbacks],
      compensation,
      failure,
      retryCount,
      startedAt,
      finishedAt: now(),
    };
  }

  function getStats() {
    return { ...stats };
  }

  function reset() {
    workflows.clear();
    for (const [id, definition] of Object.entries(SIMULATED_WORKFLOWS)) {
      workflows.set(id, { ...definition, steps: [...definition.steps] });
    }
    for (const key of Object.keys(stats)) stats[key] = 0;
  }

  return { run, registerWorkflow, getWorkflows, getStats, reset };
}
