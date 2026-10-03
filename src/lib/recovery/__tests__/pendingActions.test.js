/**
 * Deterministic recovery workflow tests (Issue #828).
 *
 * The state machine is pure and clock is injected, so every transition and
 * audit entry is asserted exactly. No database or network is required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  PENDING_ACTION_STATES,
  PendingActionTransitionError,
  classify,
  createPendingAction,
  listStalePending,
  markResolved,
  resolveManually,
  retry,
} from '../pendingActions.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');
const MINUTE = 60 * 1000;

function makeAction(overrides = {}) {
  return createPendingAction({
    id: 'action-1',
    type: 'checkout_confirm',
    createdAt: NOW,
    ...overrides,
  });
}

function collectAudit() {
  const entries = [];
  const onAudit = vi.fn((entry) => entries.push(entry));
  return { onAudit, entries };
}

describe('pending action recovery — retry success', () => {
  it('transitions pending -> resolved and audits the transition', async () => {
    const action = makeAction();
    const { onAudit, entries } = collectAudit();
    const attemptFn = vi.fn(async () => ({ ok: true }));

    const result = await retry(action, attemptFn, { now: NOW, actor: 'user:42', onAudit });

    expect(result.ok).toBe(true);
    expect(result.from).toBe(PENDING_ACTION_STATES.PENDING);
    expect(result.to).toBe(PENDING_ACTION_STATES.RESOLVED);
    expect(result.action.state).toBe('resolved');
    expect(result.action.attempts).toBe(1);
    expect(result.action.resolvedAt).toBe(NOW.toISOString());
    expect(attemptFn).toHaveBeenCalledTimes(1);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: 'pending_action_recovery',
      actionId: 'action-1',
      actionType: 'checkout_confirm',
      actor: 'user:42',
      from: 'pending',
      to: 'resolved',
      outcome: 'resolved',
      attempt: 1,
    });
  });

  it('retries a retryable action to resolution', async () => {
    const action = { ...makeAction(), state: 'retryable', attempts: 1 };
    const { entries, onAudit } = collectAudit();

    const result = await retry(action, async () => true, { now: NOW, onAudit });

    expect(result.action.state).toBe('resolved');
    expect(result.action.attempts).toBe(2);
    expect(entries[0].to).toBe('resolved');
  });
});

describe('pending action recovery — retry failure', () => {
  it('transitions pending -> retryable while retry budget remains and audits failure', async () => {
    const action = makeAction();
    const { entries, onAudit } = collectAudit();

    const result = await retry(
      action,
      async () => {
        throw new Error('horizon unavailable');
      },
      { now: NOW, actor: 'worker', maxAttempts: 3, onAudit },
    );

    expect(result.to).toBe(PENDING_ACTION_STATES.RETRYABLE);
    expect(result.action.state).toBe('retryable');
    expect(result.action.attempts).toBe(1);
    expect(result.action.lastError).toBe('horizon unavailable');
    expect(entries[0]).toMatchObject({
      event: 'pending_action_recovery',
      to: 'retryable',
      outcome: 'retryable',
      reason: 'retry_failed',
      error: 'horizon unavailable',
      attempt: 1,
    });
  });

  it('transitions to failed once the retry budget is exhausted', async () => {
    const action = { ...makeAction(), state: 'retryable', attempts: 2 };
    const { entries, onAudit } = collectAudit();

    const result = await retry(
      action,
      async () => {
        throw new Error('still down');
      },
      { now: NOW, maxAttempts: 3, onAudit },
    );

    expect(result.to).toBe(PENDING_ACTION_STATES.FAILED);
    expect(result.action.state).toBe('failed');
    expect(result.action.attempts).toBe(3);
    expect(result.action.failureReason).toBe('still down');
    expect(entries[0].to).toBe('failed');
  });
});

describe('pending action recovery — stale state', () => {
  it('is not stale before the threshold and becomes visible after it', () => {
    const action = makeAction();
    const threshold = 15 * MINUTE;

    const justBefore = classify(action, {
      now: new Date(NOW.getTime() + threshold - 1),
      staleThresholdMs: threshold,
    });
    const atThreshold = classify(action, {
      now: new Date(NOW.getTime() + threshold),
      staleThresholdMs: threshold,
    });

    expect(justBefore.stale).toBe(false);
    expect(atThreshold.stale).toBe(true);
    expect(atThreshold.ageMs).toBe(threshold);
  });

  it('lists only stale non-terminal records with age/type/attempts and no sensitive fields', async () => {
    const records = [
      makeAction({ id: 'old-pending', createdAt: new Date(NOW.getTime() - 30 * MINUTE) }),
      makeAction({ id: 'fresh', createdAt: new Date(NOW.getTime() - 1 * MINUTE) }),
      {
        ...makeAction({ id: 'old-resolved', createdAt: new Date(NOW.getTime() - 60 * MINUTE) }),
        state: 'resolved',
        payload: { secret: 'should-not-leak' },
        actor: 'user:secret',
      },
    ];

    const stale = await listStalePending(records, { now: NOW, threshold: 15 * MINUTE });

    expect(stale.map((s) => s.id)).toEqual(['old-pending']);
    expect(stale[0]).toMatchObject({
      id: 'old-pending',
      type: 'checkout_confirm',
      state: 'pending',
      attempts: 0,
    });
    expect(stale[0].ageMs).toBe(30 * MINUTE);
    expect(stale[0]).not.toHaveProperty('payload');
    expect(stale[0]).not.toHaveProperty('actor');
  });

  it('reads stale records from a Mongo-like db by collection', async () => {
    const docs = [makeAction({ id: 'db-old', createdAt: new Date(NOW.getTime() - 45 * MINUTE) })];
    const collection = { find: vi.fn(() => ({ toArray: async () => docs })) };
    const db = { collection: vi.fn(() => collection) };

    const stale = await listStalePending(db, { now: NOW, threshold: 15 * MINUTE });

    expect(db.collection).toHaveBeenCalledWith('pending_actions');
    expect(stale.map((s) => s.id)).toEqual(['db-old']);
  });
});

describe('pending action recovery — manual resolution', () => {
  it('transitions to manually_reviewed with actor + reason and audits both', async () => {
    const action = { ...makeAction(), state: 'failed', attempts: 3 };
    const { entries, onAudit } = collectAudit();

    const result = await resolveManually(action, {
      actor: 'maintainer:alice',
      reason: 'on-chain proof verified out-of-band',
      now: NOW,
      onAudit,
    });

    expect(result.to).toBe(PENDING_ACTION_STATES.MANUALLY_REVIEWED);
    expect(result.action.state).toBe('manually_reviewed');
    expect(result.action.reviewedBy).toBe('maintainer:alice');
    expect(result.action.resolutionReason).toBe('on-chain proof verified out-of-band');
    expect(entries[0]).toMatchObject({
      actor: 'maintainer:alice',
      from: 'failed',
      to: 'manually_reviewed',
      reason: 'on-chain proof verified out-of-band',
    });
  });

  it('requires an actor and a reason', async () => {
    const action = makeAction();
    await expect(resolveManually(action, { reason: 'no actor', now: NOW })).rejects.toThrow(/actor/);
    await expect(resolveManually(action, { actor: 'maint', now: NOW })).rejects.toThrow(/reason/);
  });

  it('supports the user markResolved path with an audit entry', async () => {
    const action = makeAction();
    const { entries, onAudit } = collectAudit();

    const result = await markResolved(action, { actor: 'user:42', now: NOW, onAudit });

    expect(result.action.state).toBe('resolved');
    expect(entries[0]).toMatchObject({ from: 'pending', to: 'resolved', actor: 'user:42' });
  });
});

describe('pending action recovery — guards', () => {
  it('rejects illegal transitions from terminal states', async () => {
    const resolved = { ...makeAction(), state: 'resolved' };
    await expect(retry(resolved, async () => true, { now: NOW })).rejects.toBeInstanceOf(
      PendingActionTransitionError,
    );
    await expect(markResolved(resolved, { now: NOW })).rejects.toBeInstanceOf(
      PendingActionTransitionError,
    );
  });

  it('does not emit an audit entry for a rejected transition', async () => {
    const { onAudit } = collectAudit();
    const reviewed = { ...makeAction(), state: 'manually_reviewed' };

    await expect(retry(reviewed, async () => true, { now: NOW, onAudit })).rejects.toThrow();
    expect(onAudit).not.toHaveBeenCalled();
  });
});
