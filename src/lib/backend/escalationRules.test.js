import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluateEscalation,
  evaluateEscalationBatch,
  markEscalationResolved,
  getActiveEscalationsReport,
  buildPolicy,
  DEFAULT_ESCALATION_POLICY,
  _testOnly,
} from './escalationRules.js';
import { SEVERITIES } from './partialFailures.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFailure(overrides = {}) {
  return {
    failureId: `test_${Math.random().toString(36).slice(2)}`,
    severity: SEVERITIES.HIGH,
    operation: 'payout:refund_execution',
    createdAt: new Date(),
    status: 'unresolved',
    ...overrides,
  };
}

function ago(ms) {
  return new Date(Date.now() - ms);
}

beforeEach(() => {
  _testOnly.store.clear();
});

// ── No escalation ─────────────────────────────────────────────────────────────

describe('no escalation', () => {
  it('does not fire when failure is brand new (under all thresholds)', () => {
    const failure = makeFailure({ severity: SEVERITIES.CRITICAL, createdAt: new Date() });
    const events = evaluateEscalation(failure, { now: new Date() });
    expect(events).toHaveLength(0);
  });

  it('does not fire for low severity before tier-1 threshold', () => {
    const failure = makeFailure({
      severity: SEVERITIES.LOW,
      createdAt: ago(10 * 60 * 1000), // 10 min — under 15 min tier 1
    });
    const events = evaluateEscalation(failure);
    expect(events).toHaveLength(0);
  });
});

// ── First escalation ──────────────────────────────────────────────────────────

describe('first escalation', () => {
  it('fires tier 1 for a HIGH failure after 15 min', () => {
    const failure = makeFailure({
      severity: SEVERITIES.HIGH,
      createdAt: ago(16 * 60 * 1000),
    });
    const events = evaluateEscalation(failure);
    expect(events).toHaveLength(1);
    expect(events[0].tier).toBe(1);
    expect(events[0].label).toBe('initial');
    expect(events[0].failureId).toBe(failure.failureId);
  });

  it('fires tier 1 for a CRITICAL failure after 15 min', () => {
    const failure = makeFailure({
      severity: SEVERITIES.CRITICAL,
      createdAt: ago(20 * 60 * 1000),
    });
    const events = evaluateEscalation(failure);
    expect(events).toHaveLength(1);
    expect(events[0].tier).toBe(1);
  });

  it('does not fire tier 1 for a MEDIUM failure (below severity threshold)', () => {
    const failure = makeFailure({
      severity: SEVERITIES.MEDIUM,
      createdAt: ago(20 * 60 * 1000), // past tier-1 age but medium not in tier-1 severities
    });
    const events = evaluateEscalation(failure);
    expect(events).toHaveLength(0);
  });
});

// ── Repeated escalation ───────────────────────────────────────────────────────

describe('repeated escalation (multiple tiers)', () => {
  it('fires tier 1 then tier 2 on successive evaluations', () => {
    const failure = makeFailure({
      severity: SEVERITIES.HIGH,
      createdAt: ago(16 * 60 * 1000),
    });

    const first = evaluateEscalation(failure);
    expect(first[0].tier).toBe(1);

    // Simulate failure still unresolved at 65 min
    const second = evaluateEscalation(failure, {
      now: new Date(Date.now() + 49 * 60 * 1000), // 65 min total age
    });
    expect(second).toHaveLength(1);
    expect(second[0].tier).toBe(2);
  });

  it('does not re-fire a tier already reached', () => {
    const failure = makeFailure({
      severity: SEVERITIES.HIGH,
      createdAt: ago(65 * 60 * 1000), // 65 min — past tier 1 and 2
    });

    evaluateEscalation(failure); // fires both tier 1 and 2
    const repeat = evaluateEscalation(failure); // nothing new
    expect(repeat).toHaveLength(0);
  });

  it('fires all three tiers for a CRITICAL failure unresolved for 5 hours', () => {
    const failure = makeFailure({
      severity: SEVERITIES.CRITICAL,
      createdAt: ago(5 * 60 * 60 * 1000),
    });
    const events = evaluateEscalation(failure);
    expect(events.map((e) => e.tier)).toEqual([1, 2, 3]);
  });
});

// ── Resolution stops escalation ───────────────────────────────────────────────

describe('resolution', () => {
  it('stops further tiers after markEscalationResolved', () => {
    const failure = makeFailure({
      severity: SEVERITIES.HIGH,
      createdAt: ago(16 * 60 * 1000),
    });

    evaluateEscalation(failure); // fires tier 1
    markEscalationResolved(failure.failureId);

    const after = evaluateEscalation(failure, {
      now: new Date(Date.now() + 2 * 60 * 60 * 1000), // well past tier 2
    });
    expect(after).toHaveLength(0);
  });

  it('resolved failure does not appear in active escalations report', () => {
    const failure = makeFailure({
      severity: SEVERITIES.CRITICAL,
      createdAt: ago(20 * 60 * 1000),
    });
    evaluateEscalation(failure);
    markEscalationResolved(failure.failureId);

    const report = getActiveEscalationsReport();
    const ids = Object.values(report.byTier).flat().map((e) => e.failureId);
    expect(ids).not.toContain(failure.failureId);
  });
});

// ── Policy changes ────────────────────────────────────────────────────────────

describe('policy changes', () => {
  it('respects a custom policy with a tighter tier-1 threshold (5 min)', () => {
    const customPolicy = buildPolicy([
      { tier: 1, ageThresholdMs: 5 * 60 * 1000 },
    ]);
    const failure = makeFailure({
      severity: SEVERITIES.HIGH,
      createdAt: ago(6 * 60 * 1000), // 6 min — would miss default 15-min tier 1
    });
    const events = evaluateEscalation(failure, { policy: customPolicy });
    expect(events).toHaveLength(1);
    expect(events[0].tier).toBe(1);
  });

  it('respects a custom policy with a looser tier-1 threshold (30 min)', () => {
    const customPolicy = buildPolicy([
      { tier: 1, ageThresholdMs: 30 * 60 * 1000 },
    ]);
    const failure = makeFailure({
      severity: SEVERITIES.HIGH,
      createdAt: ago(20 * 60 * 1000), // 20 min — hits default but not custom
    });
    const events = evaluateEscalation(failure, { policy: customPolicy });
    expect(events).toHaveLength(0);
  });
});

// ── Batch evaluation ──────────────────────────────────────────────────────────

describe('batch evaluation', () => {
  it('evaluates all failures and returns escalated count', () => {
    const failures = [
      makeFailure({ severity: SEVERITIES.CRITICAL, createdAt: ago(20 * 60 * 1000) }),
      makeFailure({ severity: SEVERITIES.HIGH, createdAt: ago(20 * 60 * 1000) }),
      makeFailure({ severity: SEVERITIES.LOW, createdAt: ago(60 * 1000) }), // should not escalate
    ];
    const { events, escalatedCount } = evaluateEscalationBatch(failures);
    expect(escalatedCount).toBe(2);
    expect(events.every((e) => e.tier === 1)).toBe(true);
  });
});

// ── Notify hook ───────────────────────────────────────────────────────────────

describe('notify hook', () => {
  it('calls notify once per fired tier', () => {
    const notified = [];
    const failure = makeFailure({
      severity: SEVERITIES.CRITICAL,
      createdAt: ago(5 * 60 * 60 * 1000), // 5 hours → fires all 3 tiers
    });
    evaluateEscalation(failure, { notify: (e) => notified.push(e) });
    expect(notified).toHaveLength(3);
    expect(notified.map((e) => e.tier)).toEqual([1, 2, 3]);
  });

  it('does not throw if notify throws', () => {
    const failure = makeFailure({
      severity: SEVERITIES.HIGH,
      createdAt: ago(20 * 60 * 1000),
    });
    expect(() =>
      evaluateEscalation(failure, { notify: () => { throw new Error('webhook down'); } })
    ).not.toThrow();
  });
});

// ── Report ────────────────────────────────────────────────────────────────────

describe('getActiveEscalationsReport', () => {
  it('groups active escalations by tier and severity', () => {
    const f1 = makeFailure({ severity: SEVERITIES.CRITICAL, createdAt: ago(20 * 60 * 1000) });
    const f2 = makeFailure({ severity: SEVERITIES.HIGH, createdAt: ago(20 * 60 * 1000) });
    evaluateEscalation(f1);
    evaluateEscalation(f2);

    const report = getActiveEscalationsReport();
    expect(report.total).toBe(2);
    expect(report.byTier[1]).toHaveLength(2);
    expect(report.bySeverity[SEVERITIES.CRITICAL]).toBe(1);
    expect(report.bySeverity[SEVERITIES.HIGH]).toBe(1);
  });

  it('minTier filter excludes lower tiers', () => {
    const f = makeFailure({
      severity: SEVERITIES.CRITICAL,
      createdAt: ago(5 * 60 * 60 * 1000),
    });
    evaluateEscalation(f); // reaches tier 3

    const report = getActiveEscalationsReport({ minTier: 3 });
    expect(report.total).toBe(1);
    expect(report.byTier[3]).toHaveLength(1);
    expect(report.byTier[1]).toBeUndefined();
  });
});
