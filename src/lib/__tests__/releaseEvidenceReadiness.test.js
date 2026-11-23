import { describe, expect, it } from 'vitest';
import { evaluateReleaseReadiness } from '../release/readiness.js';

const validEvidence = (overrides = {}) => ({
  release: 'v1.0.0',
  commit: 'abc123',
  generatedAt: '2026-10-20T10:00:00.000Z',
  migrations: [{ id: '001', status: 'applied', dryRunPassed: true, rollbackDocumented: true }],
  securityChecks: { dependencyAudit: 'passed', secretScan: 'passed' },
  smokeTests: { status: 'passed' },
  rollbackRehearsal: { status: 'passed', rehearsedAt: '2026-10-20T09:00:00.000Z', restoredToCommit: 'known-good' },
  ...overrides,
});

describe('release evidence readiness gate', () => {
  it('passes complete evidence for the requested commit', () => {
    const report = evaluateReleaseReadiness(validEvidence(), { expectedCommit: 'abc123', now: new Date('2026-10-21T00:00:00Z') });
    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it('blocks pending migrations and stale rollback rehearsals', () => {
    const report = evaluateReleaseReadiness(validEvidence({
      migrations: [{ id: '002', status: 'pending' }],
      rollbackRehearsal: { status: 'passed', rehearsedAt: '2026-08-01T00:00:00Z', restoredToCommit: 'known-good' },
    }), { expectedCommit: 'abc123', now: new Date('2026-10-21T00:00:00Z') });
    expect(report.ready).toBe(false);
    expect(report.blockers.map((blocker) => blocker.gate)).toEqual(expect.arrayContaining(['migrations', 'rollback_rehearsal']));
  });
});
