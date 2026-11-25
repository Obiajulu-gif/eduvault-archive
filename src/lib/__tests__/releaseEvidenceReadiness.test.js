import { describe, expect, it } from 'vitest';
import { evaluateReleaseReadiness } from '../release/readiness.js';

const validEvidence = (overrides = {}) => ({
  release: 'v1.0.0',
  commit: 'abc123',
  generatedAt: '2026-10-20T10:00:00.000Z',
  migrations: [{ id: '001', status: 'applied', dryRunPassed: true, rollbackDocumented: true, rollbackVerification: 'verified' }],
  securityChecks: { dependencyAudit: 'passed', secretScan: 'passed' },
  smokeTests: { status: 'passed' },
  rollbackRehearsal: { status: 'passed', rehearsedAt: '2026-10-20T09:00:00.000Z', restoredToCommit: 'known-good' },
  ...overrides,
});

const now = new Date('2026-10-21T00:00:00Z');
const gates = (report) => report.blockers.map((blocker) => blocker.gate);

describe('release evidence readiness gate', () => {
  it('passes complete evidence for the requested commit', () => {
    const report = evaluateReleaseReadiness(validEvidence(), { expectedCommit: 'abc123', now });
    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it('blocks pending migrations and stale rollback rehearsals', () => {
    const report = evaluateReleaseReadiness(validEvidence({
      migrations: [{ id: '002', status: 'pending' }],
      rollbackRehearsal: { status: 'passed', rehearsedAt: '2026-08-01T00:00:00Z', restoredToCommit: 'known-good' },
    }), { expectedCommit: 'abc123', now });
    expect(report.ready).toBe(false);
    expect(gates(report)).toEqual(expect.arrayContaining(['migrations', 'rollback_rehearsal']));
  });
});

// #1156: migration recovery evidence and commit binding.
describe('release gate: commit binding (#1156)', () => {
  it('passes a release commit that only adds evidence on top of the evidenced commit', () => {
    const report = evaluateReleaseReadiness(validEvidence(), {
      expectedCommit: 'def456',
      changedFilesSinceEvidence: ['release/readiness.json'],
      now,
    });
    expect(report.ready).toBe(true);
  });

  it('passes when the trees are identical (no changed files)', () => {
    const report = evaluateReleaseReadiness(validEvidence(), { expectedCommit: 'def456', changedFilesSinceEvidence: [], now });
    expect(report.ready).toBe(true);
  });

  it('blocks a release whose code changed after the evidence was produced', () => {
    const report = evaluateReleaseReadiness(validEvidence(), {
      expectedCommit: 'def456',
      changedFilesSinceEvidence: ['release/readiness.json', 'src/lib/purchases.js'],
      now,
    });
    expect(report.ready).toBe(false);
    expect(report.blockers[0]).toMatchObject({ gate: 'evidence' });
    expect(report.blockers[0].message).toContain('src/lib/purchases.js');
  });

  it('blocks evidence for another commit when the diff is unknown', () => {
    const report = evaluateReleaseReadiness(validEvidence(), { expectedCommit: 'def456', changedFilesSinceEvidence: null, now });
    expect(gates(report)).toEqual(['evidence']);
  });

  it('blocks evidence dated in the future, which would never go stale', () => {
    const report = evaluateReleaseReadiness(validEvidence({ generatedAt: '2099-01-01T00:00:00Z' }), { expectedCommit: 'abc123', now });
    expect(gates(report)).toEqual(['evidence']);
  });

  it('tolerates a few minutes of clock skew', () => {
    const report = evaluateReleaseReadiness(validEvidence({ generatedAt: '2026-10-21T00:04:00Z' }), { expectedCommit: 'abc123', now });
    expect(report.ready).toBe(true);
  });
});

describe('release gate: migration recovery evidence (#1156)', () => {
  const migrationBlocker = (migrations) => {
    const report = evaluateReleaseReadiness(validEvidence({ migrations }), { expectedCommit: 'abc123', now });
    return report.blockers.find((blocker) => blocker.gate === 'migrations')?.message;
  };

  it('requires a verified rollback rehearsal for every applied migration', () => {
    const base = { id: '003', status: 'applied', dryRunPassed: true, rollbackDocumented: true };
    expect(migrationBlocker([base])).toContain('003: applied migrations need rollbackVerification');
    expect(migrationBlocker([{ ...base, rollbackVerification: 'drift' }])).toContain('rollbackVerification');
    expect(migrationBlocker([{ ...base, rollbackVerification: 'unverifiable' }])).toContain('rollbackVerification');
    expect(migrationBlocker([{ ...base, rollbackVerification: 'verified' }])).toBeUndefined();
  });

  it('does not ask for recovery evidence when a migration is not required', () => {
    expect(migrationBlocker([{ id: '004', status: 'not_required' }])).toBeUndefined();
    expect(migrationBlocker([])).toBeUndefined();
  });

  it('blocks unnamed and duplicate migrations', () => {
    expect(migrationBlocker([{ status: 'not_required' }])).toContain('non-empty id');
    expect(migrationBlocker([{ id: '   ', status: 'not_required' }])).toContain('non-empty id');
    expect(migrationBlocker([null])).toContain('non-empty id');
    expect(migrationBlocker([
      { id: '005', status: 'not_required' },
      { id: '005', status: 'not_required' },
    ])).toContain('005: listed more than once');
  });

  it('blocks malformed migration lists', () => {
    for (const migrations of [undefined, null, {}, 'none']) {
      const report = evaluateReleaseReadiness(validEvidence({ migrations }), { expectedCommit: 'abc123', now });
      expect(gates(report)).toContain('migrations');
    }
  });
});

describe('release gate: rollback rehearsal recovery evidence (#1156)', () => {
  const rehearsalReport = (rollbackRehearsal) =>
    evaluateReleaseReadiness(validEvidence({ rollbackRehearsal }), { expectedCommit: 'abc123', now });

  it('blocks a rehearsal that "restored" to the release candidate itself', () => {
    const report = rehearsalReport({ status: 'passed', rehearsedAt: '2026-10-20T09:00:00Z', restoredToCommit: 'abc123' });
    expect(gates(report)).toEqual(['rollback_rehearsal']);
  });

  it('blocks a future-dated rehearsal', () => {
    const report = rehearsalReport({ status: 'passed', rehearsedAt: '2099-01-01T00:00:00Z', restoredToCommit: 'known-good' });
    expect(gates(report)).toEqual(['rollback_rehearsal']);
  });

  it('blocks a failed rehearsal, then passes once it is re-run and recorded (retry path)', () => {
    const failed = rehearsalReport({ status: 'failed', rehearsedAt: '2026-10-20T09:00:00Z', restoredToCommit: 'known-good' });
    expect(failed.ready).toBe(false);
    const retried = rehearsalReport({ status: 'passed', rehearsedAt: '2026-10-20T11:00:00Z', restoredToCommit: 'known-good' });
    expect(retried.ready).toBe(true);
  });

  it('is read-only and deterministic, so re-running the gate is safe', () => {
    const evidence = validEvidence();
    const snapshot = JSON.stringify(evidence);
    const first = evaluateReleaseReadiness(evidence, { expectedCommit: 'abc123', now });
    const second = evaluateReleaseReadiness(evidence, { expectedCommit: 'abc123', now });
    expect(second).toEqual(first);
    expect(JSON.stringify(evidence)).toBe(snapshot);
  });

  it('blocks missing or non-object evidence', () => {
    for (const evidence of [null, undefined, 'evidence', 42]) {
      expect(evaluateReleaseReadiness(evidence, { now }).ready).toBe(false);
    }
  });
});
