import { describe, expect, it } from 'vitest';
import { collectContributorDiagnostics } from '../contributorDiagnostics.js';

describe('contributor diagnostics (#1061)', () => {
  it('reports setup presence without exposing environment values', () => {
    const report = collectContributorDiagnostics({
      env: { MONGODB_URI: 'mongodb://user:secret@example.test/db' },
      dependencyReport: {
        status: 'misconfigured',
        remediations: [{ dependency: 'database', hint: 'Configure MONGODB_URI.' }],
        dependencies: { database: { message: 'password=secret' } },
      },
    });
    expect(report.environment.MONGODB_URI).toBe(true);
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(report.remediation).toHaveLength(1);
  });

  it('marks unavailable services as retryable and includes runtime context', () => {
    const report = collectContributorDiagnostics({
      env: {},
      dependencyReport: { status: 'unavailable', remediations: [] },
    });
    expect(report.retryable).toBe(true);
    expect(report.runtime.node).toMatch(/^v\d+/);
    expect(report.environment.MONGODB_URI).toBe(false);
  });
});
