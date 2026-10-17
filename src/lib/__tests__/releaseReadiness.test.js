import { describe, expect, it } from 'vitest';
import {
  CheckStatus,
  ReleaseDecision,
  checkDeploymentAuthorization,
  checkEnvironmentReadiness,
  checkRollbackReadiness,
  evaluateReleaseReadiness,
} from '../release/releaseReadiness.js';

describe('Release Readiness Suite (Issue #1022)', () => {
  it('validates authorized deployer roles', () => {
    const ok = checkDeploymentAuthorization({ id: 'dep-1', role: 'deployer' });
    expect(ok.status).toBe(CheckStatus.PASSED);

    const bad = checkDeploymentAuthorization({ id: 'guest-1', role: 'guest' });
    expect(bad.status).toBe(CheckStatus.FAILED);
  });

  it('validates critical environment secrets', () => {
    const env = { JWT_SECRET: 'abc', NEXT_PUBLIC_STELLAR_NETWORK: 'TESTNET' };
    expect(checkEnvironmentReadiness(env).status).toBe(CheckStatus.PASSED);

    expect(checkEnvironmentReadiness({}).status).toBe(CheckStatus.FAILED);
  });

  it('verifies rollback backup freshness', () => {
    const fresh = new Date().toISOString();
    expect(checkRollbackReadiness({ lastBackupTimestamp: fresh }).status).toBe(CheckStatus.PASSED);
    expect(checkRollbackReadiness({ lastBackupTimestamp: null }).status).toBe(CheckStatus.FAILED);
  });

  it('orchestrates release evaluation decision', async () => {
    const rep = await evaluateReleaseReadiness({
      actor: { id: 'admin-1', role: 'admin' },
      db: null,
      env: { JWT_SECRET: 'abc', NEXT_PUBLIC_STELLAR_NETWORK: 'TESTNET' },
    });
    // DB is null -> blocked
    expect(rep.decision).toBe(ReleaseDecision.BLOCKED);
  });
});
